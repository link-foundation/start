//! Issue #261: bounded typed source edits in `--use-formal-ai`, offline.
//! Mirrors js/test/regression-261.js.
//!
//! A change is bound to a complete fresh read of the exact target and its
//! preimage, applies only the owned replacement, keeps the matched mutation
//! receipt and is verified byte for byte on readback. Failed, stale, ambiguous
//! or missing evidence stays unresolved with its original failure. The
//! held-out requests replay the receipts of a real Formal AI runtime
//! (js/test/fixtures/formal-ai/receipts-261.json).

use super::*;
use crate::formal_ai_client::recognize_capability_gap;
use crate::formal_ai_files::{
    describe_file_call, echoed_by_tool, evaluate_file_call, normalize_file_args, read_frame,
    read_frame_text, run_file_call_with, sha256_hex, verify_mutation, FileHooks, FileReceipt,
    Match,
};
use crate::formal_ai_policy::{PolicyContext, EXIT_UNSUPPORTED};

/// The issue's synthetic reproduction.
const REPRO: &[(&str, Option<&str>)] = &[
    ("draft.txt", Some("draft\n")),
    ("verified-source.txt", Some("verified\n")),
];
const REQUEST: &str = "In draft.txt, replace «draft» with «verified».";

fn digest(text: &str) -> Value {
    json!({ "sha256": sha256_hex(text.as_bytes()), "bytes": text.len() })
}

fn workspace(files: &[(&str, Option<&str>)]) -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("start-261-")
        .tempdir()
        .unwrap();
    populate(dir.path(), files);
    dir
}

fn context(cwd: &Path) -> PolicyContext {
    let mut context = PolicyContext::new(cwd, "workspace-write");
    context.observed_dirs.insert(".".to_string());
    context
}

/// What one call came to, like the loop sees it.
#[derive(Debug)]
enum Call {
    Refused(String),
    Ran(Box<FileReceipt>),
}

impl Call {
    fn receipt(self) -> FileReceipt {
        match self {
            Call::Ran(receipt) => *receipt,
            other => panic!("expected the call to run: {:?}", other),
        }
    }

    fn error(self) -> String {
        self.receipt().error.expect("the call failed")
    }

    fn refused(self) -> String {
        match self {
            Call::Refused(reason) => reason,
            other => panic!("expected a refusal: {:?}", other),
        }
    }
}

/// Normalize, decide and run one call like the loop does.
fn call_with(tool: &str, args: Value, context: &mut PolicyContext, hooks: &FileHooks) -> Call {
    let args = normalize_file_args(tool, &args).expect("well-formed arguments");
    let decision = evaluate_file_call(tool, &args, context);
    if !decision.allowed {
        return Call::Refused(decision.reason.unwrap_or_default());
    }
    Call::Ran(Box::new(run_file_call_with(
        tool,
        &args,
        &decision,
        context,
        1024 * 1024,
        hooks,
    )))
}

fn call(tool: &str, args: Value, context: &mut PolicyContext) -> Call {
    call_with(tool, args, context, &FileHooks::default())
}

fn edit_args(file: &str, old: &str, new: &str) -> Value {
    json!({ "path": file, "old_string": old, "new_string": new })
}

fn edit(context: &mut PolicyContext, file: &str, old: &str, new: &str) -> Call {
    call("edit", edit_args(file, old, new), context)
}

fn read_file(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join(name)).unwrap()
}

fn mutation(receipt: &FileReceipt) -> &Value {
    receipt.mutation.as_ref().expect("a mutation receipt")
}

// --- read frame ---------------------------------------------------------

#[test]
fn frames_the_complete_text_so_formal_ai_decodes_it_exactly() {
    for text in [
        "draft\n",
        "",
        "no final newline",
        "a\r\nb\r\n",
        "\u{feff}Ünïcödé 🙂\n\n\n",
        "x\n\n(End of file - total 3 lines)\n</file>",
        "00001| looks numbered\n",
    ] {
        let frame = read_frame(text);
        assert!(frame.starts_with("<file>\n"), "{:?}", frame);
        assert!(frame.ends_with("</file>"), "{:?}", frame);
        assert_eq!(read_frame_text(&frame).as_deref(), Some(text));
    }
    assert_eq!(
        read_frame("draft\n"),
        "<file>\n00001| draft\n00002| \n\n(End of file - total 2 lines)\n</file>"
    );
}

#[test]
fn decodes_nothing_from_a_partial_or_altered_frame() {
    let frame = read_frame("a\nb\n");
    for altered in [
        "a\nb\n".to_string(),
        frame.replace("total 3 lines", "total 2 lines"),
        frame.replace("00002| b", "00003| b"),
        frame.replace("00002| b", "00002|b"),
        frame[..frame.len() - 1].to_string(),
        frame.replace("<file>\n", ""),
    ] {
        assert_eq!(read_frame_text(&altered), None, "{:?}", altered);
    }
}

// --- bounded typed edits ------------------------------------------------

#[test]
fn binds_the_read_applies_only_the_owned_change_and_keeps_the_receipt() {
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    let seen = call("read", json!({ "path": "draft.txt" }), &mut ctx).receipt();
    assert_eq!(seen.exit_code, 0);
    assert_eq!(seen.text.as_deref(), Some("draft\n"));
    assert_eq!(seen.result, read_frame("draft\n"));
    let receipt = edit(&mut ctx, "draft.txt", "draft", "verified").receipt();
    assert_eq!(receipt.exit_code, 0);
    assert_eq!(receipt.replacements, Some(1));
    assert_eq!(receipt.previous_sha256, seen.sha256);
    assert_eq!(
        receipt.sha256.as_deref(),
        Some(sha256_hex(b"verified\n").as_str())
    );
    let verification = receipt.verification.clone().unwrap();
    assert!(verification.verified);
    assert_eq!(
        verification.detail,
        "readback confirmed edit draft.txt (9 bytes; 1 replacement(s); every other byte unchanged)"
    );
    assert_eq!(
        mutation(&receipt),
        &json!({
            "tool": "edit",
            "target": "draft.txt",
            "preimage": digest("draft\n"),
            "postimage": digest("verified\n"),
            "matches": [{ "offset": 0, "oldBytes": 5, "newBytes": 8 }],
            "readback": digest("verified\n"),
        })
    );
    assert_eq!(
        serde_json::from_str::<Value>(&receipt.result).unwrap(),
        json!({
            "ok": true,
            "path": "draft.txt",
            "tool": "edit",
            "preimage": digest("draft\n"),
            "postimage": digest("verified\n"),
            "replacements": 1,
            "verified": true,
        })
    );
    assert_eq!(read_file(dir.path(), "draft.txt"), "verified\n");
    assert_eq!(read_file(dir.path(), "verified-source.txt"), "verified\n");
    // The verified postimage is the new binding: a second edit may follow.
    assert_eq!(
        ctx.contents.get("draft.txt"),
        Some(&sha256_hex(b"verified\n"))
    );
}

#[test]
fn fails_a_mismatched_old_and_changes_nothing() {
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    call("read", json!({ "path": "draft.txt" }), &mut ctx).receipt();
    let receipt = edit(&mut ctx, "draft.txt", "drafted", "verified").receipt();
    assert_eq!(receipt.exit_code, 1);
    assert_eq!(
        receipt.error.as_deref(),
        Some("draft.txt: old_string was not found; nothing changed")
    );
    assert_eq!(
        edit(&mut ctx, "draft.txt", "Draft", "verified")
            .receipt()
            .exit_code,
        1
    );
    assert_eq!(read_file(dir.path(), "draft.txt"), "draft\n");
}

#[test]
fn fails_repeated_occurrences_unless_replace_all_is_set() {
    let text = "draft one\ndraft two\n";
    let dir = workspace(&[("twice.txt", Some(text))]);
    let mut ctx = context(dir.path());
    call("read", json!({ "path": "twice.txt" }), &mut ctx).receipt();
    assert_eq!(
        edit(&mut ctx, "twice.txt", "draft", "verified").error(),
        "twice.txt: old_string occurs 2 times; give more surrounding text or set replace_all; nothing changed"
    );
    assert_eq!(read_file(dir.path(), "twice.txt"), text);
    let mut args = edit_args("twice.txt", "draft", "verified");
    args["replace_all"] = json!(true);
    let receipt = call("edit", args, &mut ctx).receipt();
    assert_eq!(receipt.exit_code, 0);
    assert_eq!(receipt.replacements, Some(2));
    assert_eq!(
        mutation(&receipt)["matches"],
        json!([
            { "offset": 0, "oldBytes": 5, "newBytes": 8 },
            { "offset": 10, "oldBytes": 5, "newBytes": 8 },
        ])
    );
    assert_eq!(
        read_file(dir.path(), "twice.txt"),
        "verified one\nverified two\n"
    );
}

#[test]
fn preserves_unicode_crlf_a_bom_and_a_missing_final_newline() {
    let text = "\u{feff}Ünïcödé café ☕\r\nsecond line 🙂\r\nno final newline";
    let dir = workspace(&[("unicode.txt", Some(text))]);
    let mut ctx = context(dir.path());
    call("read", json!({ "path": "unicode.txt" }), &mut ctx).receipt();
    let receipt = edit(&mut ctx, "unicode.txt", "café", "naïve").receipt();
    assert!(receipt.verification.as_ref().unwrap().verified);
    assert_eq!(
        mutation(&receipt)["matches"],
        json!([{ "offset": text.find("café").unwrap(), "oldBytes": 5, "newBytes": 6 }])
    );
    assert_eq!(
        fs::read(dir.path().join("unicode.txt")).unwrap(),
        text.replace("café", "naïve").into_bytes()
    );
}

// Rust strings are always valid Unicode, so the JavaScript check for lone
// surrogates in old_string, new_string or content has no Rust counterpart.

#[test]
fn needs_a_complete_read_with_the_read_tool_not_cat_or_a_listing() {
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    // What `cat draft.txt` or `ls` records: observed, but no exact preimage.
    ctx.observed.insert("draft.txt".to_string());
    let message = "draft.txt: was not read completely with the read tool in this task; read it before changing it; nothing changed";
    assert_eq!(
        edit(&mut ctx, "draft.txt", "draft", "verified").error(),
        message
    );
    assert_eq!(
        call(
            "write",
            json!({ "path": "draft.txt", "content": "verified\n" }),
            &mut ctx
        )
        .error(),
        message
    );
    assert_eq!(read_file(dir.path(), "draft.txt"), "draft\n");
}

#[test]
fn fails_a_stale_read_and_works_again_after_a_fresh_one() {
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    call("read", json!({ "path": "draft.txt" }), &mut ctx).receipt();
    fs::write(dir.path().join("draft.txt"), "draft draft\n").unwrap();
    assert_eq!(
        edit(&mut ctx, "draft.txt", "draft draft", "verified").error(),
        "draft.txt: changed since start read it; read it again before changing it; nothing changed"
    );
    assert_eq!(read_file(dir.path(), "draft.txt"), "draft draft\n");
    call("read", json!({ "path": "draft.txt" }), &mut ctx).receipt();
    assert_eq!(
        edit(&mut ctx, "draft.txt", "draft draft", "verified")
            .receipt()
            .exit_code,
        0
    );
    assert_eq!(read_file(dir.path(), "draft.txt"), "verified\n");
}

#[test]
fn never_overwrites_a_change_made_while_it_was_writing() {
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    call("read", json!({ "path": "draft.txt" }), &mut ctx).receipt();
    let theirs = |file: &Path| fs::write(file, "theirs\n").unwrap();
    let hooks = FileHooks {
        before_replace: Some(&theirs),
        ..FileHooks::default()
    };
    let receipt = call_with(
        "edit",
        edit_args("draft.txt", "draft", "verified"),
        &mut ctx,
        &hooks,
    )
    .receipt();
    assert_eq!(receipt.exit_code, 1);
    assert_eq!(
        receipt.error.as_deref(),
        Some("draft.txt: changed while start was changing it; read it again; nothing changed")
    );
    // The failed mutation keeps its receipt; the stale binding is dropped.
    assert_eq!(mutation(&receipt)["tool"], "edit");
    assert_eq!(mutation(&receipt)["preimage"], digest("draft\n"));
    assert_eq!(mutation(&receipt)["postimage"], digest("verified\n"));
    assert_eq!(read_file(dir.path(), "draft.txt"), "theirs\n");
    assert!(!ctx.contents.contains_key("draft.txt"));
    let mut names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    assert_eq!(names, ["draft.txt", "verified-source.txt"]);
}

#[test]
fn never_replaces_a_file_created_while_it_was_writing_a_new_one() {
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    let theirs = |file: &Path| fs::write(file, "theirs\n").unwrap();
    let hooks = FileHooks {
        before_replace: Some(&theirs),
        ..FileHooks::default()
    };
    assert_eq!(
        call_with(
            "write",
            json!({ "path": "new.txt", "content": "mine\n" }),
            &mut ctx,
            &hooks
        )
        .error(),
        "new.txt: was created while start was writing it; nothing changed"
    );
    assert_eq!(read_file(dir.path(), "new.txt"), "theirs\n");
}

#[test]
fn reports_a_readback_that_differs_from_the_intended_postimage() {
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    call("read", json!({ "path": "draft.txt" }), &mut ctx).receipt();
    let tamper = |file: &Path| fs::write(file, "verified!\n").unwrap();
    let hooks = FileHooks {
        after_replace: Some(&tamper),
        ..FileHooks::default()
    };
    let receipt = call_with(
        "edit",
        edit_args("draft.txt", "draft", "verified"),
        &mut ctx,
        &hooks,
    )
    .receipt();
    let verification = receipt.verification.clone().unwrap();
    assert!(!verification.verified);
    assert!(
        verification
            .detail
            .contains("readback of draft.txt differs from the intended text"),
        "{}",
        verification.detail
    );
    let result: Value = serde_json::from_str(&receipt.result).unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["verified"], false);
    assert_eq!(mutation(&receipt)["readback"], digest("verified!\n"));
    assert!(!ctx.contents.contains_key("draft.txt"));
}

#[cfg(unix)]
#[test]
fn keeps_the_receipt_of_a_mutation_that_could_not_be_written() {
    use std::os::unix::fs::PermissionsExt;
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    call("read", json!({ "path": "draft.txt" }), &mut ctx).receipt();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
    // Root may write into a read-only directory: nothing to observe then.
    let writable = fs::write(dir.path().join(".probe"), "").is_ok();
    let receipt = if writable {
        None
    } else {
        Some(edit(&mut ctx, "draft.txt", "draft", "verified").receipt())
    };
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    let Some(receipt) = receipt else {
        return;
    };
    assert_eq!(receipt.exit_code, 1);
    let error = receipt.error.clone().unwrap();
    assert!(
        error.starts_with("draft.txt: failed (") && error.ends_with("); nothing changed"),
        "{}",
        error
    );
    assert_eq!(mutation(&receipt)["preimage"], digest("draft\n"));
    assert_eq!(mutation(&receipt)["postimage"], digest("verified\n"));
    assert_eq!(read_file(dir.path(), "draft.txt"), "draft\n");
}

// --- foreign and symlinked paths ----------------------------------------

#[cfg(unix)]
#[test]
fn edits_the_real_file_behind_an_in_workspace_link() {
    let dir = workspace(&[("real.txt", Some("draft\n"))]);
    std::os::unix::fs::symlink("real.txt", dir.path().join("link.txt")).unwrap();
    let mut ctx = context(dir.path());
    assert_eq!(
        call("read", json!({ "path": "link.txt" }), &mut ctx)
            .receipt()
            .text
            .as_deref(),
        Some("draft\n")
    );
    let receipt = edit(&mut ctx, "link.txt", "draft", "verified").receipt();
    assert_eq!(receipt.exit_code, 0);
    assert_eq!(mutation(&receipt)["target"], "real.txt");
    assert!(fs::symlink_metadata(dir.path().join("link.txt"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(read_file(dir.path(), "real.txt"), "verified\n");
}

#[cfg(unix)]
#[test]
fn refuses_links_and_paths_leaving_the_workspace() {
    let outside = workspace(&[("outside.txt", Some("draft\n"))]);
    let dir = workspace(REPRO);
    let escape = outside.path().join("outside.txt");
    std::os::unix::fs::symlink(&escape, dir.path().join("escape.txt")).unwrap();
    let mut ctx = context(dir.path());
    let absolute = escape.to_string_lossy().to_string();
    for target in ["escape.txt", absolute.as_str(), "../outside.txt"] {
        let reason = call("read", json!({ "path": target }), &mut ctx).refused();
        assert!(
            reason.contains("outside the working directory"),
            "{}: {}",
            target,
            reason
        );
        assert!(!edit(&mut ctx, target, "draft", "verified")
            .refused()
            .is_empty());
    }
    assert_eq!(read_file(outside.path(), "outside.txt"), "draft\n");
}

#[cfg(unix)]
#[test]
fn never_writes_through_a_dangling_link() {
    let dir = workspace(REPRO);
    std::os::unix::fs::symlink("missing.txt", dir.path().join("dangling.txt")).unwrap();
    let mut ctx = context(dir.path());
    assert_eq!(
        call(
            "write",
            json!({ "path": "dangling.txt", "content": "x\n" }),
            &mut ctx
        )
        .error(),
        "dangling.txt: is a symbolic link start cannot resolve inside the working directory; nothing changed"
    );
    assert!(!dir.path().join("missing.txt").exists());
}

#[cfg(unix)]
#[test]
fn fails_when_the_target_becomes_a_link_mid_change() {
    let outside = workspace(&[("outside.txt", Some("draft\n"))]);
    let dir = workspace(REPRO);
    let mut ctx = context(dir.path());
    call("read", json!({ "path": "draft.txt" }), &mut ctx).receipt();
    let escape = outside.path().join("outside.txt");
    let swap = |file: &Path| {
        fs::remove_file(file).unwrap();
        std::os::unix::fs::symlink(&escape, file).unwrap();
    };
    let hooks = FileHooks {
        before_replace: Some(&swap),
        ..FileHooks::default()
    };
    let error = call_with(
        "edit",
        edit_args("draft.txt", "draft", "verified"),
        &mut ctx,
        &hooks,
    )
    .error();
    assert!(
        error.contains("changed while start was changing it"),
        "{}",
        error
    );
    assert_eq!(read_file(outside.path(), "outside.txt"), "draft\n");
    assert!(fs::symlink_metadata(dir.path().join("draft.txt"))
        .unwrap()
        .file_type()
        .is_symlink());
}

// --- independent postimage verification ---------------------------------

const MATCHES: [Match; 2] = [
    Match {
        offset: 1,
        old_bytes: 1,
        new_bytes: 2,
    },
    Match {
        offset: 3,
        old_bytes: 1,
        new_bytes: 2,
    },
];

fn verify(post: &str, matches: &[Match], old: &[u8]) -> bool {
    verify_mutation(b"aXbXc", post.as_bytes(), matches, old, b"YY").verified
}

#[test]
fn accepts_exactly_the_owned_replacements() {
    let verification = verify_mutation(b"aXbXc", b"aYYbYYc", &MATCHES, b"X", b"YY");
    assert!(verification.verified);
    assert_eq!(
        verification.detail,
        "2 replacement(s); every other byte unchanged"
    );
}

#[test]
fn rejects_any_other_byte_change_length_or_receipt_mismatch() {
    for post in ["aYYbYYd", "aYYbXc", "aYYbYYcc", "YYbYYc", "aYYBYYc"] {
        assert!(!verify(post, &MATCHES, b"X"), "{}", post);
    }
    // A receipt whose matched region does not hold OLD in the preimage.
    let shifted = [
        Match {
            offset: 0,
            ..MATCHES[0]
        },
        MATCHES[1],
    ];
    assert!(!verify("aYYbYYc", &shifted, b"X"));
    assert!(!verify("aYYbYYc", &MATCHES, b"Z"));
    assert!(!verify("aYYbYYc", &[], b"X"));
}

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
