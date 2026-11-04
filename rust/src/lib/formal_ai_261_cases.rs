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

#[path = "formal_ai_261_loop_cases.rs"]
mod loop_cases;
