//! Issue #261, continued: unresolved failures and gap records in the task
//! loop, and the held-out requests against the captured receipts of a real
//! Formal AI runtime (js/test/fixtures/formal-ai/receipts-261.json). Mirrors
//! js/test/regression-261.js.

use super::*;

// --- unresolved failures in the task loop -------------------------------

/// A scripted client recording every conversation it is sent.
struct Scripted {
    turns: Vec<Completion>,
    sent: Vec<Vec<Value>>,
}

impl CompletionClient for Scripted {
    fn complete(
        &mut self,
        messages: &[Value],
        _cancel: &dyn Fn() -> bool,
    ) -> Result<Completion, ClientError> {
        self.sent.push(messages.to_vec());
        Ok(self.turns.remove(0))
    }

    fn requests(&self) -> u64 {
        self.sent.len() as u64
    }
}

fn calls(tool_calls: Vec<ToolCall>) -> Completion {
    Completion {
        content: String::new(),
        finish_reason: Some("tool_calls".to_string()),
        tool_calls,
        handler: None,
    }
}

fn typed(tool: &str, args: Value) -> Completion {
    let normalized = normalize_file_args(tool, &args).unwrap();
    calls(vec![ToolCall {
        id: Some(format!("c_{}", tool)),
        name: tool.to_string(),
        tool: tool.to_string(),
        command: describe_file_call(tool, &normalized),
        arguments: args.to_string(),
        args: Some(normalized),
    }])
}

fn bash(command: &str) -> Completion {
    calls(vec![ToolCall {
        id: Some("c_bash".to_string()),
        name: "bash".to_string(),
        tool: "bash".to_string(),
        command: command.to_string(),
        arguments: json!({ "command": command }).to_string(),
        args: None,
    }])
}

fn answered(content: &str) -> Completion {
    Completion {
        content: content.to_string(),
        finish_reason: Some("stop".to_string()),
        tool_calls: Vec::new(),
        handler: None,
    }
}

fn read_draft() -> Completion {
    typed("read", json!({ "path": "draft.txt" }))
}

fn edit_draft(old: &str) -> Completion {
    typed("edit", edit_args("draft.txt", old, "verified"))
}

struct Looped {
    _dir: tempfile::TempDir,
    outcome: Value,
    evidence: Value,
    sent: Vec<Vec<Value>>,
    draft: String,
    source: String,
}

fn looped_in(turns: Vec<Completion>, files: &[(&str, Option<&str>)]) -> Looped {
    let dir = workspace(files);
    let bounds = Bounds {
        effects: "workspace-write".to_string(),
        ..Bounds::default()
    };
    let mut client = Scripted {
        turns,
        sent: Vec::new(),
    };
    let mut evidence = json!({});
    let outcome = run_formal_ai_task(
        &TaskOptions {
            request: REQUEST,
            cwd: dir.path(),
            env: &[],
            bounds: &bounds,
            deadline: Instant::now() + Duration::from_secs(60),
            mirror: false,
            note: &|_| {},
            cancel: &|| None,
        },
        &mut client,
        &mut evidence,
    );
    Looped {
        draft: read_file(dir.path(), "draft.txt"),
        source: read_file(dir.path(), "verified-source.txt"),
        _dir: dir,
        outcome: outcome.to_json(),
        evidence,
        sent: client.sent,
    }
}

fn looped(turns: Vec<Completion>) -> Looped {
    looped_in(turns, REPRO)
}

#[test]
fn completes_the_exact_reproduction_with_a_verified_edit() {
    let result = looped(vec![
        read_draft(),
        edit_draft("draft"),
        bash("sha256sum -- draft.txt"),
        answered("Replaced `draft` with `verified` in `draft.txt`."),
    ]);
    assert_eq!(
        result.outcome,
        json!({
            "status": "completed",
            "exitCode": 0,
            "message": "finished after 3 tool call(s); changed draft.txt",
            "remainingObligations": [],
        })
    );
    assert_eq!(result.draft, "verified\n");
    assert_eq!(result.source, "verified\n");
    let tool_messages: Vec<&Value> = result.sent[3]
        .iter()
        .filter(|m| m["role"] == "tool")
        .collect();
    let [read_message, edit_message, digest_message] = tool_messages[..] else {
        panic!("expected three tool messages: {:?}", tool_messages);
    };
    assert_eq!(read_message["content"], read_frame("draft\n"));
    let change: Value = serde_json::from_str(edit_message["content"].as_str().unwrap()).unwrap();
    assert_eq!(change["ok"], true);
    assert_eq!(change["verified"], true);
    assert_eq!(change["postimage"], digest("verified\n"));
    assert!(digest_message["content"]
        .as_str()
        .unwrap()
        .contains(&sha256_hex(b"verified\n")));
    let step = result.evidence["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["tool"] == "edit")
        .unwrap();
    assert_eq!(step["mutation"]["preimage"], digest("draft\n"));
    assert_eq!(step["mutation"]["postimage"], digest("verified\n"));
    assert_eq!(step["mutation"]["readback"], digest("verified\n"));
}

#[test]
fn keeps_an_edit_after_cat_unresolved() {
    let result = looped(vec![
        bash("cat draft.txt"),
        edit_draft("draft"),
        answered("Done."),
    ]);
    assert_eq!(result.outcome["status"], "incomplete");
    assert_eq!(result.outcome["exitCode"], 1);
    assert_eq!(result.outcome["failures"][0]["command"], "edit draft.txt");
    assert_eq!(
        result.outcome["failures"][0]["error"],
        "draft.txt: was not read completely with the read tool in this task; read it before changing it; nothing changed"
    );
    assert_eq!(result.draft, "draft\n");
}

#[test]
fn keeps_a_mismatched_old_unresolved_after_a_later_read() {
    let result = looped(vec![
        read_draft(),
        edit_draft("drafted"),
        read_draft(),
        answered("Done."),
    ]);
    assert_eq!(
        result.outcome,
        json!({
            "status": "incomplete",
            "exitCode": 1,
            "message": "`edit draft.txt` failed (draft.txt: old_string was not found; nothing changed) and no later call resolved it; no file changed",
            "remainingObligations": [
                "`edit draft.txt` failed: draft.txt: old_string was not found; nothing changed",
            ],
            "failures": [{
                "command": "edit draft.txt",
                "tool": "edit",
                "target": "draft.txt",
                "exitCode": 1,
                "error": "draft.txt: old_string was not found; nothing changed",
            }],
        })
    );
}

#[test]
fn resolves_a_failed_edit_only_by_a_verified_change_of_the_target() {
    let result = looped(vec![
        read_draft(),
        edit_draft("drafted"),
        edit_draft("draft"),
        answered("Done."),
    ]);
    assert_eq!(result.outcome["status"], "completed");
    assert_eq!(result.outcome["exitCode"], 0);
    assert_eq!(result.draft, "verified\n");
}

#[test]
fn never_takes_a_copy_as_the_substring_edit() {
    let result = looped(vec![
        read_draft(),
        edit_draft("drafted"),
        typed("read", json!({ "path": "verified-source.txt" })),
        bash("cp verified-source.txt draft.txt"),
        answered("Done."),
    ]);
    // The copy ran and its effect is reported, but the edit stays failed.
    assert_eq!(result.draft, "verified\n");
    assert_eq!(result.outcome["status"], "incomplete");
    assert_eq!(result.outcome["exitCode"], 1);
    assert_eq!(result.outcome["failures"][0]["command"], "edit draft.txt");
    let message = result.outcome["message"].as_str().unwrap();
    assert!(message.contains("changed draft.txt"), "{}", message);
}

#[test]
fn keeps_a_failed_bash_write_unresolved_until_the_same_call_succeeds() {
    let result = looped(vec![
        read_draft(),
        bash("mkdir draft.txt"),
        bash("touch draft.txt"),
        answered("Done."),
    ]);
    assert_eq!(result.outcome["status"], "incomplete");
    assert_eq!(result.outcome["failures"][0]["command"], "mkdir draft.txt");
}

#[test]
fn exits_65_when_formal_ai_cannot_bind_the_preimage() {
    let gap = json!({
        "complete": false,
        "reason": "SourcePreimageUnavailable",
        "schema": "workspace-change-verification-gap/v1",
        "target": "draft.txt",
        "verified": false,
    })
    .to_string();
    let recognized = recognize_capability_gap(&gap, &[]).expect("a known gap");
    assert_eq!(recognized["reason"], "SourcePreimageUnavailable");
    assert_eq!(recognized["target"], "draft.txt");
    let result = looped(vec![read_draft(), edit_draft("draft"), answered(&gap)]);
    assert_eq!(result.outcome["status"], "capability-gap");
    assert_eq!(result.outcome["exitCode"], EXIT_UNSUPPORTED);
    assert_eq!(
        result.outcome["message"],
        "Formal AI reported a capability gap for draft.txt (SourcePreimageUnavailable); Formal AI did not confirm the task as done; start observed: changed draft.txt"
    );
}

#[test]
fn exits_65_on_an_obligation_gap_in_formal_ai_notation() {
    let record = "obligation_49c9d049437c0075\n  record_type \"obligation_gap\"\n  clause \"Preserve all other content.\"\n  span_start \"85\"\n  span_end \"112\"\n  reason \"no_artifact_in_clause\"";
    let result = looped(vec![read_draft(), edit_draft("draft"), answered(record)]);
    assert_eq!(
        result.outcome,
        json!({
            "status": "incomplete",
            "exitCode": EXIT_UNSUPPORTED,
            "message": "Formal AI reported obligation_gap (no_artifact_in_clause) for the clause \"Preserve all other content.\"; nothing was verified as done by Formal AI; changed draft.txt",
            "remainingObligations": ["Formal AI did not confirm the requested change"],
            "gapRecord": {
                "schema": "obligation_gap",
                "reason": "no_artifact_in_clause",
                "clause": "Preserve all other content.",
            },
        })
    );
    // Prose, other records and a record echoed from a file are no gap.
    for content in [
        "The edit is done.",
        "obligation_1\n  record_type \"obligation_done\"",
        "obligation 1\n  record_type \"obligation_gap\"",
        "obligation_1\nrecord_type \"obligation_gap\"",
    ] {
        let other = looped(vec![read_draft(), answered(content)]);
        assert_eq!(other.outcome["status"], "completed", "{:?}", content);
    }
    // A record or gap the read tool returned from a file, numbered in the
    // read frame, is file data, not Formal AI's answer.
    let gap = serde_json::to_string_pretty(&json!({
        "schema": "workspace-change-verification-gap/v1",
        "target": "draft.txt",
        "reason": "SourcePreimageUnavailable",
        "complete": false,
        "verified": false,
    }))
    .unwrap();
    for answer in [record, gap.as_str()] {
        let file = format!("{}\n", answer);
        let echoed = looped_in(
            vec![read_draft(), answered(answer)],
            &[
                ("draft.txt", Some(file.as_str())),
                ("verified-source.txt", Some("verified\n")),
            ],
        );
        assert_eq!(echoed.outcome["status"], "completed", "{}", answer);
    }
    let frame = read_frame(&format!("{}\n", record));
    assert!(echoed_by_tool(
        record,
        &[json!({ "role": "tool", "content": frame })]
    ));
    assert!(!echoed_by_tool(
        record,
        &[json!({ "role": "user", "content": record })]
    ));
}

// --- held-out edits against captured receipts ---------------------------

#[test]
fn covers_every_held_out_case_of_the_issue() {
    let names: Vec<&str> = held_out_receipts()["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["name"].as_str())
        .collect();
    assert_eq!(
        names,
        [
            "issue reproduction",
            "issue reproduction, read-only",
            "mismatched OLD",
            "repeated occurrences",
            "Unicode and CRLF",
            "symlinked path",
            "symlink leaving the workspace",
            "foreign path",
        ]
    );
}

/// Run one captured request through the real loop and the replay server.
#[cfg(unix)]
fn replay(receipt: &Value) -> Value {
    let base = tempfile::Builder::new()
        .prefix("start-261-replay-")
        .tempdir()
        .unwrap();
    let cwd = base.path().join("ws");
    fs::create_dir(&cwd).unwrap();
    let files = receipt["files"].as_object().unwrap();
    for (name, text) in files {
        let target = cwd.join(name);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, text.as_str().unwrap()).unwrap();
    }
    for (link, target) in receipt["links"].as_object().unwrap() {
        std::os::unix::fs::symlink(target.as_str().unwrap(), cwd.join(link)).unwrap();
    }
    let result = run(
        receipt["request"].as_str().unwrap(),
        Opts {
            cwd: Some(&cwd),
            effects: receipt["effects"].as_str(),
            ..Opts::default()
        },
    );
    let after: serde_json::Map<String, Value> = files
        .keys()
        .map(|name| (name.clone(), json!(read_file(&cwd, name))))
        .collect();
    json!({
        "name": receipt["name"],
        "outcome": result.outcome.to_json(),
        "tools": result
            .tools
            .iter()
            .map(|t| json!([t["command"], t["decision"], t["exitCode"]]))
            .collect::<Vec<_>>(),
        "after": after,
    })
}

#[cfg(unix)]
#[test]
fn every_held_out_request_replays_to_its_outcome_and_file_bytes() {
    for receipt in held_out_receipts()["receipts"].as_array().unwrap() {
        let tools: Vec<Value> = receipt["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| json!([t["command"], t["decision"], t["exitCode"]]))
            .collect();
        assert_eq!(
            replay(receipt),
            json!({
                "name": receipt["name"],
                "outcome": receipt["outcome"],
                "tools": tools,
                "after": receipt["after"],
            })
        );
    }
}

#[test]
fn the_reproduction_leaves_the_source_unchanged() {
    let repro = &held_out_receipts()["receipts"][0];
    assert_eq!(repro["outcome"]["status"], "completed");
    assert_eq!(repro["outcome"]["exitCode"], 0);
    assert_eq!(
        repro["after"],
        json!({ "draft.txt": "verified\n", "verified-source.txt": "verified\n" })
    );
    let commands: Vec<&Value> = repro["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| &t["command"])
        .collect();
    assert_eq!(
        commands,
        [
            &json!("read draft.txt"),
            &json!("edit draft.txt"),
            &json!("sha256sum -- draft.txt"),
        ]
    );
}
