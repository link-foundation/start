//! Issues #257 and #258 through the task loop: the captured 5xx cause in the
//! evidence, capability gaps reported as incomplete, and the structured file
//! tools replayed from js/test/fixtures/formal-ai/receipts-258.json.
//! Mirrors js/test/regression-257.js, regression-258.js and
//! regression-258-files.js.

use super::*;
use crate::formal_ai_client::bash_tool;
use crate::formal_ai_files::normalize_file_args;
#[cfg(unix)]
use crate::formal_ai_files::sha256_hex;

const ISSUE_EDIT: &str = "In snippet.mjs, replace the before label declaration with the after label declaration, preserving all other content.";
const LITERAL_EDIT: &str = "In snippet.mjs, replace «const label = \"before\";» with «const label = \"after\";». Preserve all other content.";
const CAUSE: &str =
    "Aborted(Error: LocalProductWasmForbidden). Build with -sASSERTIONS for more info.";

fn original() -> String {
    edit_receipts()["fixture"]["snippet.mjs"]
        .as_str()
        .unwrap()
        .to_string()
}

fn edited() -> String {
    original().replacen("const label = \"before\";", "const label = \"after\";", 1)
}

/// A fresh copy of the #258 fixture.
fn snippet_fixture() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("start-258-fixture-")
        .tempdir()
        .unwrap();
    fs::write(dir.path().join("snippet.mjs"), original()).unwrap();
    dir
}

struct Edit {
    result: Run,
    text: String,
    _dir: tempfile::TempDir,
}

fn run_edit(request: &str, effects: &str, tools: Option<Vec<Value>>) -> Edit {
    let dir = snippet_fixture();
    let result = run(
        request,
        Opts {
            cwd: Some(dir.path()),
            effects: Some(effects),
            tools,
            ..Opts::default()
        },
    );
    let text = fs::read_to_string(dir.path().join("snippet.mjs")).unwrap();
    Edit {
        result,
        text,
        _dir: dir,
    }
}

#[test]
fn records_the_captured_5xx_cause_in_the_evidence_and_changes_nothing() {
    let result = run(
        "synthetic: server error (captured #257)",
        Opts {
            effects: Some("workspace-write"),
            max_retries: Some(1),
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.status, "protocol-error");
    assert_eq!(result.outcome.exit_code, EXIT_PROTOCOL);
    assert_eq!(
        result.outcome.message,
        format!(
            "Formal AI returned HTTP 500: formal_ai_error: {} (after 1 retry)",
            CAUSE
        )
    );
    let outcome = &result.evidence["outcome"];
    assert_eq!(outcome["diagnostics"]["httpStatus"], 500);
    assert_eq!(outcome["diagnostics"]["errorType"], "formal_ai_error");
    assert_eq!(outcome["diagnostics"]["errorMessage"], CAUSE);
    assert_eq!(outcome["diagnostics"]["bodyPreview"], CAPTURED_500);
    assert_eq!(outcome["diagnostics"]["attempts"], 2);
    assert_eq!(result.requests, 2);
    assert!(result.tools.is_empty());
    assert_eq!(result.after, result.before);
}

#[test]
fn reports_the_bash_only_gap_as_incomplete_with_exit_65() {
    let edit = run_edit(ISSUE_EDIT, "workspace-write", Some(vec![bash_tool()]));
    let result = &edit.result;
    assert_eq!(
        result.sent[0],
        vec![json!({ "role": "user", "content": ISSUE_EDIT })]
    );
    assert_eq!(
        result.outcome.to_json(),
        json!({
            "status": "capability-gap",
            "exitCode": EXIT_UNSUPPORTED,
            "message": "Formal AI reported a capability gap for snippet.mjs (EditToolUnavailable; missing read, edit); nothing was verified as done",
            "remainingObligations": ["the requested change to snippet.mjs was not made or not verified"],
            "gap": {
                "schema": "workspace-edit-capability-gap/v1",
                "target": "snippet.mjs",
                "reason": "EditToolUnavailable",
                "missingCapabilities": ["read", "edit"],
                "complete": false,
                "verified": false,
            },
        })
    );
    assert!(result.tools.is_empty());
    assert_eq!(edit.text, original());
}

#[test]
fn keeps_answering_plain_questions_with_exit_0() {
    for tools in [Some(vec![bash_tool()]), None] {
        let result = run_edit("What is 2 + 2?", "read-only", tools).result;
        assert_eq!(result.outcome.status, "answered");
        assert_eq!(result.outcome.exit_code, 0);
        assert!(result.outcome.remaining.is_empty());
    }
}

#[cfg(unix)]
#[test]
fn every_captured_edit_request_replays_to_its_captured_outcome_and_text() {
    for receipt in edit_receipts()["receipts"].as_array().unwrap() {
        let request = receipt["request"].as_str().unwrap();
        let effects = receipt["effects"].as_str().unwrap();
        let offered: Vec<&str> = receipt["offered"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let tools = if offered == ["bash"] {
            vec![bash_tool()]
        } else {
            offered_tools(effects)
        };
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert_eq!(names, offered);
        let edit = run_edit(request, effects, Some(tools));
        let calls = |tools: &[Value]| -> Vec<Value> {
            tools
                .iter()
                .map(|t| json!([t["command"], t["decision"], t["exitCode"]]))
                .collect()
        };
        let label = format!("{} [{}, {}]", request, effects, offered.join(","));
        assert_eq!(
            edit.result.outcome.to_json(),
            receipt["outcome"],
            "{}",
            label
        );
        assert_eq!(
            calls(&edit.result.tools),
            calls(receipt["tools"].as_array().unwrap()),
            "{}",
            label
        );
        assert_eq!(edit.text, receipt["after"]["snippet.mjs"], "{}", label);
    }
}

#[cfg(unix)]
#[test]
fn reads_edits_and_reads_back_preserving_all_other_bytes() {
    let edit = run_edit(LITERAL_EDIT, "workspace-write", None);
    let result = &edit.result;
    // start verified the edit byte for byte, but Formal AI's final answer is
    // a gap for the clause "Preserve all other content.": that is never
    // reported as done (#261).
    assert_eq!(result.outcome.status, "incomplete");
    assert_eq!(result.outcome.exit_code, EXIT_UNSUPPORTED);
    assert_eq!(
        result.outcome.message,
        "Formal AI reported obligation_gap (no_artifact_in_clause) for the clause \"Preserve all other content.\"; nothing was verified as done by Formal AI; changed snippet.mjs"
    );
    assert_eq!(
        result.outcome.remaining,
        vec!["Formal AI did not confirm the requested change"]
    );
    assert_eq!(
        result.outcome.gap_record,
        Some(json!({
            "schema": "obligation_gap",
            "reason": "no_artifact_in_clause",
            "clause": "Preserve all other content.",
        }))
    );
    assert_eq!(
        result.evidence["outcome"]["gapRecord"]["schema"],
        "obligation_gap"
    );
    assert_eq!(edit.text, edited());
    let [read, change, check] = &result.tools[..] else {
        panic!("expected three tool calls: {:?}", result.tools);
    };
    assert_eq!(read["tool"], "read");
    assert_eq!(read["effect"], "read");
    assert_eq!(read["exitCode"], 0);
    assert_eq!(read["bytes"], original().len() as u64);
    assert_eq!(change["tool"], "edit");
    assert_eq!(change["effect"], "write");
    assert_eq!(change["target"], "snippet.mjs");
    assert_eq!(change["replacements"], 1);
    assert_eq!(change["previousSha256"], read["sha256"]);
    assert_eq!(change["sha256"], sha256_hex(edited().as_bytes()));
    assert_eq!(change["verification"]["verified"], true);
    assert_eq!(
        change["effects"],
        json!({ "added": [], "removed": [], "changed": ["snippet.mjs"], "complete": true })
    );
    assert_eq!(check["command"], "sha256sum -- snippet.mjs");
    assert_eq!(check["exitCode"], 0);
    // Formal AI received the exact file text (framed), the raw edit
    // arguments and the readback hash.
    let last = &result.sent[3];
    let tool_messages: Vec<&Value> = last.iter().filter(|m| m["role"] == "tool").collect();
    assert_eq!(
        tool_messages[0]["content"],
        crate::formal_ai_files::read_frame(&original())
    );
    assert!(tool_messages[2]["content"]
        .as_str()
        .unwrap()
        .contains(change["sha256"].as_str().unwrap()));
    let edit_call = &last
        .iter()
        .filter(|m| m["role"] == "assistant")
        .nth(1)
        .unwrap()["tool_calls"][0]["function"];
    assert_eq!(edit_call["name"], "edit");
    let arguments: Value = serde_json::from_str(edit_call["arguments"].as_str().unwrap()).unwrap();
    assert!(normalize_file_args("edit", &arguments).is_ok());
    assert_eq!(
        result.evidence["effects"]["changed"],
        json!(["snippet.mjs"])
    );
}

#[test]
fn reports_the_missing_edit_tool_in_read_only_mode_with_the_remedy() {
    let edit = run_edit(LITERAL_EDIT, "read-only", None);
    let outcome = &edit.result.outcome;
    assert_eq!(outcome.status, "capability-gap");
    assert_eq!(outcome.exit_code, EXIT_UNSUPPORTED);
    assert_eq!(
        outcome.gap.as_ref().unwrap()["missingCapabilities"],
        json!(["edit"])
    );
    assert_eq!(
        outcome.remaining,
        vec![
            "the requested change to snippet.mjs was not made or not verified",
            "set START_FORMAL_AI_EFFECTS=workspace-write to offer the edit and write tools",
        ]
    );
    assert_eq!(edit.text, original());
}

#[test]
fn shows_a_file_through_the_read_tool_without_changing_it() {
    let edit = run_edit("show contents of snippet.mjs", "read-only", None);
    let result = &edit.result;
    assert_eq!(
        (result.outcome.status.as_str(), result.outcome.exit_code),
        ("completed", 0)
    );
    let commands: Vec<&Value> = result.tools.iter().map(|t| &t["command"]).collect();
    assert_eq!(commands, [&json!("read snippet.mjs")]);
    assert_eq!(
        result.sent[1][2]["content"],
        crate::formal_ai_files::read_frame(&original())
    );
    assert_eq!(edit.text, original());
    assert_eq!(result.after, result.before);
}

/// A scripted client: each turn returns the next completion.
struct Scripted(Vec<Completion>);

impl CompletionClient for Scripted {
    fn complete(
        &mut self,
        _messages: &[Value],
        _cancel: &dyn Fn() -> bool,
    ) -> Result<Completion, ClientError> {
        Ok(self.0.remove(0))
    }

    fn requests(&self) -> u64 {
        0
    }
}

fn file_call(tool: &str, args: Value) -> Completion {
    let normalized = normalize_file_args(tool, &args).unwrap();
    Completion {
        content: String::new(),
        finish_reason: Some("tool_calls".to_string()),
        tool_calls: vec![ToolCall {
            id: Some(format!("c_{}", tool)),
            name: tool.to_string(),
            tool: tool.to_string(),
            command: format!("{} {}", tool, normalized.path),
            arguments: args.to_string(),
            args: Some(normalized),
        }],
        handler: None,
    }
}

fn final_answer(content: &str) -> Completion {
    Completion {
        content: content.to_string(),
        finish_reason: Some("stop".to_string()),
        tool_calls: Vec::new(),
        handler: None,
    }
}

fn scripted_loop(turns: Vec<Completion>, effects: &str) -> (Outcome, bool) {
    let dir = snippet_fixture();
    let before = snapshot(dir.path());
    let bounds = Bounds {
        effects: effects.to_string(),
        ..Bounds::default()
    };
    let mut evidence = json!({});
    let outcome = run_formal_ai_task(
        &TaskOptions {
            request: "scripted",
            cwd: dir.path(),
            env: &[],
            bounds: &bounds,
            deadline: Instant::now() + Duration::from_secs(30),
            mirror: false,
            note: &|_| {},
            cancel: &|| None,
        },
        &mut Scripted(turns),
        &mut evidence,
    );
    (outcome, snapshot(dir.path()) == before)
}

#[test]
fn stops_with_77_before_an_unobserved_edit_runs() {
    let (outcome, unchanged) = scripted_loop(
        vec![file_call(
            "edit",
            json!({ "path": "snippet.mjs", "old_string": "before", "new_string": "after" }),
        )],
        "workspace-write",
    );
    assert_eq!(
        (outcome.status.as_str(), outcome.exit_code),
        ("refused", EXIT_REFUSED)
    );
    assert_eq!(
        outcome.remaining,
        vec!["the refused call did not run; nothing after it ran either"]
    );
    assert!(unchanged);
}

#[test]
fn refuses_edits_in_read_only_mode_even_after_a_read() {
    let (outcome, unchanged) = scripted_loop(
        vec![
            file_call("read", json!({ "path": "snippet.mjs" })),
            file_call(
                "edit",
                json!({ "path": "snippet.mjs", "old_string": "before", "new_string": "after" }),
            ),
        ],
        "read-only",
    );
    assert_eq!(outcome.exit_code, EXIT_REFUSED);
    assert!(outcome.message.contains("read-only"), "{}", outcome.message);
    assert!(unchanged);
}

#[test]
fn reports_a_failed_edit_with_its_real_status_and_no_change() {
    let (outcome, unchanged) = scripted_loop(
        vec![
            file_call("read", json!({ "path": "snippet.mjs" })),
            file_call(
                "edit",
                json!({ "path": "snippet.mjs", "old_string": "zzz", "new_string": "b" }),
            ),
            final_answer("The edit failed."),
        ],
        "workspace-write",
    );
    // The failure stays unresolved with its original error (#261).
    assert_eq!(
        (outcome.status.as_str(), outcome.exit_code),
        ("incomplete", 1)
    );
    assert_eq!(
        outcome.remaining,
        vec!["`edit snippet.mjs` failed: snippet.mjs: old_string was not found; nothing changed"]
    );
    assert_eq!(
        outcome.failures,
        vec![json!({
            "command": "edit snippet.mjs",
            "tool": "edit",
            "target": "snippet.mjs",
            "exitCode": 1,
            "error": "snippet.mjs: old_string was not found; nothing changed",
        })]
    );
    assert!(unchanged);
}

#[test]
fn describes_gaps_and_their_obligations() {
    let gap = json!({
        "target": "a.js",
        "reason": "VerificationRunToolUnavailable",
        "missingCapabilities": [],
    });
    assert_eq!(
        describe_gap(&gap, &EffectDiff::default()),
        "Formal AI reported a capability gap for a.js (VerificationRunToolUnavailable); nothing was verified as done"
    );
    assert_eq!(
        gap_obligations(&gap, "read-only"),
        vec!["the requested change to a.js was not made or not verified"]
    );
    let write_gap = json!({ "target": "a.js", "reason": "EditToolUnavailable", "missingCapabilities": ["write"] });
    assert_eq!(gap_obligations(&write_gap, "read-only").len(), 2);
    assert_eq!(gap_obligations(&write_gap, "workspace-write").len(), 1);
}
