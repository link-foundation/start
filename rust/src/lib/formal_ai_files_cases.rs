//! Issue #258: the structured read, edit and write tools of `--use-formal-ai`.
//! Mirrors js/test/regression-258-files.js.

use super::*;
use crate::formal_ai_policy::formal_ai_policy_cases::populate;
use crate::formal_ai_policy::{resolve_bounds_with, Bounds};

const TEXT: &str =
    "// keep this comment\r\nconst a = 1;\t \n\n  const b = 2; // b\nconst a2 = 1;\n";

fn workspace() -> tempfile::TempDir {
    let dir = tempfile::Builder::new()
        .prefix("start-258-files-")
        .tempdir()
        .unwrap();
    populate(
        dir.path(),
        &[("a.js", Some(TEXT)), ("sub/b.txt", Some("one two one\n"))],
    );
    dir
}

fn default_limit() -> u64 {
    Bounds::default().max_file_bytes
}

/// What one call came to, like the loop sees it.
#[derive(Debug)]
enum Call {
    Problem(String),
    Refused(String),
    Ran(FileReceipt),
}

impl Call {
    fn receipt(self) -> FileReceipt {
        match self {
            Call::Ran(receipt) => receipt,
            other => panic!("expected the call to run: {:?}", other),
        }
    }

    fn error(self) -> String {
        self.receipt().error.expect("the call failed")
    }

    fn problem(self) -> String {
        match self {
            Call::Problem(problem) => problem,
            other => panic!("expected malformed arguments: {:?}", other),
        }
    }
}

/// Normalize, decide and run one call like the loop does.
fn call(tool: &str, args: Value, context: &mut PolicyContext, limit: u64) -> Call {
    let args = match normalize_file_args(tool, &args) {
        Ok(args) => args,
        Err(problem) => return Call::Problem(problem),
    };
    let decision = evaluate_file_call(tool, &args, context);
    if !decision.allowed {
        return Call::Refused(decision.reason.unwrap_or_default());
    }
    Call::Ran(run_file_call(tool, &args, &decision, context, limit))
}

fn read(path: &str, context: &mut PolicyContext) -> FileReceipt {
    call("read", json!({ "path": path }), context, default_limit()).receipt()
}

#[test]
fn normalizes_aliases_and_rejects_malformed_arguments() {
    let args = normalize_file_args(
        "read",
        &json!({ "filePath": "a.js", "file_path": "a.js", "path": "a.js" }),
    )
    .unwrap();
    assert_eq!(args.path, "a.js");
    assert_eq!(describe_file_call("read", &args), "read a.js");
    let edit = normalize_file_args(
        "edit",
        &json!({ "file_path": "a.js", "oldString": "x", "new_string": "y", "replaceAll": true }),
    )
    .unwrap();
    assert_eq!(edit.old_string.as_deref(), Some("x"));
    assert_eq!(edit.new_string.as_deref(), Some("y"));
    assert!(edit.replace_all);
    let problem = |tool: &str, args: Value| normalize_file_args(tool, &args).unwrap_err();
    assert!(
        problem("read", json!({ "path": "a.js", "file_path": "b.js" })).contains("conflicting")
    );
    assert_eq!(
        problem("edit", json!({ "path": "a.js", "old_string": "x" })),
        "edit needs new_string"
    );
    assert_eq!(
        problem("write", json!({ "path": "a.js" })),
        "write needs content"
    );
    assert!(problem("read", json!({ "path": 3 })).contains("must be a string"));
    assert!(problem("read", json!({ "path": "  " })).contains("non-empty path"));
    assert!(problem("read", json!(["a.js"])).contains("not a JSON object"));
    assert!(problem(
        "edit",
        json!({ "path": "a", "old_string": "x", "new_string": "y", "replace_all": "yes" })
    )
    .contains("must be a boolean"));
}

#[test]
fn offers_identical_file_tool_schemas() {
    for name in FILE_TOOL_NAMES {
        let tool = file_tool(name);
        assert_eq!(tool["type"], "function");
        assert_eq!(tool["function"]["name"], name);
        assert!(tool["function"]["parameters"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("path")));
    }
}

#[test]
fn refuses_read_only_changes_outside_paths_and_unobserved_targets() {
    let dir = workspace();
    let cwd = dir.path();
    let mut read_only = PolicyContext::new(cwd, "read-only");
    read("a.js", &mut read_only);
    let refused = |tool: &str, args: Value, context: &mut PolicyContext| match call(
        tool,
        args,
        context,
        default_limit(),
    ) {
        Call::Refused(reason) => reason,
        other => panic!("expected a refusal: {:?}", other),
    };
    assert!(refused(
        "edit",
        json!({ "path": "a.js", "old_string": "a", "new_string": "b" }),
        &mut read_only
    )
    .contains("read-only"));
    let mut context = PolicyContext::new(cwd, "workspace-write");
    for outside in ["../x.txt", "/etc/hostname", "~/x.txt"] {
        assert!(refused("read", json!({ "path": outside }), &mut context)
            .contains("outside the working directory"));
    }
    assert!(refused("read", json!({ "path": "." }), &mut context).contains("not a file"));
    assert_eq!(
        refused(
            "edit",
            json!({ "path": "a.js", "old_string": "a", "new_string": "b" }),
            &mut context
        ),
        "target \"a.js\" was not read before the change"
    );
    assert_eq!(
        refused(
            "write",
            json!({ "path": "new.txt", "content": "x" }),
            &mut context
        ),
        "target \"new.txt\" was not observed before the change"
    );
    // A new file in a listed directory may be written.
    context.observed_dirs.insert(".".to_string());
    assert_eq!(
        call(
            "write",
            json!({ "path": "new.txt", "content": "x" }),
            &mut context,
            default_limit()
        )
        .receipt()
        .exit_code,
        0
    );
    assert_eq!(fs::read_to_string(cwd.join("new.txt")).unwrap(), "x");
}

#[cfg(unix)]
#[test]
fn refuses_a_symlink_that_escapes_the_workspace() {
    let dir = workspace();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "secret\n").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        dir.path().join("link.txt"),
    )
    .unwrap();
    let mut context = PolicyContext::new(dir.path(), "workspace-write");
    match call(
        "read",
        json!({ "path": "link.txt" }),
        &mut context,
        default_limit(),
    ) {
        Call::Refused(reason) => assert!(reason.contains("outside the working directory")),
        other => panic!("expected a refusal: {:?}", other),
    }
    assert!(context.observed.is_empty());
}

#[test]
fn reads_the_exact_text_and_records_the_observation() {
    let dir = workspace();
    let mut context = PolicyContext::new(dir.path(), "read-only");
    let receipt = read("./a.js", &mut context);
    assert_eq!(receipt.exit_code, 0);
    assert_eq!(receipt.result, TEXT);
    assert_eq!(receipt.bytes, Some(TEXT.len() as u64));
    assert!(context.observed.contains("a.js"));
    assert_eq!(context.contents.get("a.js"), receipt.sha256.as_ref());
    assert_eq!(receipt.sha256.unwrap(), sha256_hex(TEXT.as_bytes()));
}

#[test]
fn fails_for_missing_directory_oversized_and_non_text_files() {
    let dir = workspace();
    let cwd = dir.path();
    fs::write(cwd.join("bin.dat"), [0xff, 0xfe, 0]).unwrap();
    fs::write(cwd.join("nul.txt"), "a\0b").unwrap();
    fs::write(cwd.join("big.txt"), "x".repeat(64)).unwrap();
    let mut context = PolicyContext::new(cwd, "read-only");
    let missing = read("missing.txt", &mut context);
    assert_eq!(missing.exit_code, 1);
    assert_eq!(missing.error.as_deref(), Some("missing.txt: no such file"));
    assert_eq!(
        serde_json::from_str::<Value>(&missing.result).unwrap(),
        json!({ "ok": false, "is_error": true, "error": "missing.txt: no such file" })
    );
    let error = |name: &str, limit: u64, context: &mut PolicyContext| {
        call("read", json!({ "path": name }), context, limit).error()
    };
    let limit = default_limit();
    assert_eq!(
        error("sub", limit, &mut context),
        "sub: is a directory, not a file"
    );
    assert_eq!(
        error("bin.dat", limit, &mut context),
        "bin.dat: is not UTF-8 text"
    );
    assert_eq!(
        error("nul.txt", limit, &mut context),
        "nul.txt: is not UTF-8 text"
    );
    assert_eq!(
        error("big.txt", 10, &mut context),
        "big.txt: has 64 bytes; START_FORMAL_AI_MAX_FILE_BYTES is 10"
    );
    assert!(context.observed.is_empty());
}

#[test]
fn edits_one_literal_occurrence_preserving_every_other_byte_and_the_mode() {
    let dir = workspace();
    let cwd = dir.path();
    let file = cwd.join("a.js");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let mut context = PolicyContext::new(cwd, "workspace-write");
    let before = read("a.js", &mut context);
    let receipt = call(
        "edit",
        json!({ "path": "a.js", "old_string": "const b = 2;", "new_string": "const b = $&3;" }),
        &mut context,
        default_limit(),
    )
    .receipt();
    let expected = TEXT.replacen("const b = 2;", "const b = $&3;", 1);
    assert_eq!(receipt.exit_code, 0);
    assert_eq!(receipt.result, "");
    assert_eq!(receipt.replacements, Some(1));
    assert_eq!(receipt.previous_sha256, before.sha256);
    assert_eq!(receipt.sha256, Some(sha256_hex(expected.as_bytes())));
    assert!(receipt.verification.as_ref().unwrap().verified);
    let evidence = receipt.evidence();
    assert_eq!(evidence["replacements"], 1);
    assert_eq!(evidence["bytes"], expected.len() as u64);
    assert_eq!(fs::read_to_string(&file).unwrap(), expected);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
    // No temporary file is left behind.
    let mut names: Vec<String> = fs::read_dir(cwd)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    assert_eq!(names, ["a.js", "sub"]);
}

#[test]
fn keeps_a_byte_order_mark() {
    let dir = workspace();
    let cwd = dir.path();
    fs::write(cwd.join("bom.txt"), "\u{feff}first\nsecond\n").unwrap();
    let mut context = PolicyContext::new(cwd, "workspace-write");
    assert_eq!(
        read("bom.txt", &mut context).result,
        "\u{feff}first\nsecond\n"
    );
    let receipt = call(
        "edit",
        json!({ "path": "bom.txt", "old_string": "second", "new_string": "2nd" }),
        &mut context,
        default_limit(),
    )
    .receipt();
    assert_eq!(receipt.exit_code, 0);
    assert_eq!(
        fs::read(cwd.join("bom.txt")).unwrap(),
        "\u{feff}first\n2nd\n".as_bytes()
    );
}

#[test]
fn refuses_ambiguous_missing_empty_and_no_op_replacements() {
    let dir = workspace();
    let cwd = dir.path();
    let mut context = PolicyContext::new(cwd, "workspace-write");
    read("sub/b.txt", &mut context);
    let mut edit = |old: &str, new: &str, all: bool| {
        call(
            "edit",
            json!({ "path": "sub/b.txt", "old_string": old, "new_string": new, "replace_all": all }),
            &mut context,
            default_limit(),
        )
        .receipt()
    };
    assert_eq!(
        edit("one", "1", false).error.as_deref(),
        Some("sub/b.txt: old_string occurs 2 times; give more surrounding text or set replace_all; nothing changed")
    );
    assert!(edit("three", "3", false)
        .error
        .unwrap()
        .contains("not found"));
    assert!(edit("", "3", false).error.unwrap().contains("empty"));
    assert!(edit("two", "two", false)
        .error
        .unwrap()
        .contains("the same"));
    assert_eq!(
        fs::read_to_string(cwd.join("sub/b.txt")).unwrap(),
        "one two one\n"
    );
    let all = edit("one", "1", true);
    assert_eq!((all.exit_code, all.replacements), (0, Some(2)));
    assert_eq!(
        fs::read_to_string(cwd.join("sub/b.txt")).unwrap(),
        "1 two 1\n"
    );
}

#[test]
fn does_not_overwrite_a_file_changed_since_it_was_read() {
    let dir = workspace();
    let cwd = dir.path();
    let mut context = PolicyContext::new(cwd, "workspace-write");
    read("a.js", &mut context);
    fs::write(cwd.join("a.js"), "someone else\n").unwrap();
    let edit = call(
        "edit",
        json!({ "path": "a.js", "old_string": "else", "new_string": "x" }),
        &mut context,
        default_limit(),
    );
    assert!(edit.error().contains("changed since start read it"));
    let write = call(
        "write",
        json!({ "path": "a.js", "content": "x" }),
        &mut context,
        default_limit(),
    );
    assert!(write.error().contains("changed since start read it"));
    assert_eq!(
        fs::read_to_string(cwd.join("a.js")).unwrap(),
        "someone else\n"
    );
}

#[test]
fn keeps_the_file_size_bound_for_the_new_text() {
    let dir = workspace();
    let cwd = dir.path();
    let mut context = PolicyContext::new(cwd, "workspace-write");
    let limit = TEXT.len() as u64;
    call("read", json!({ "path": "a.js" }), &mut context, limit).receipt();
    let error = call(
        "edit",
        json!({ "path": "a.js", "old_string": "const a = 1;", "new_string": "const a = 10;" }),
        &mut context,
        limit,
    )
    .error();
    assert!(error.contains("START_FORMAL_AI_MAX_FILE_BYTES"));
    assert_eq!(fs::read_to_string(cwd.join("a.js")).unwrap(), TEXT);
}

#[test]
fn writes_a_read_file_and_refuses_a_missing_directory() {
    let dir = workspace();
    let cwd = dir.path();
    let mut context = PolicyContext::new(cwd, "workspace-write");
    read("a.js", &mut context);
    let receipt = call(
        "write",
        json!({ "path": "a.js", "content": "new\n" }),
        &mut context,
        default_limit(),
    )
    .receipt();
    assert_eq!((receipt.exit_code, receipt.bytes), (0, Some(4)));
    assert!(receipt.verification.unwrap().verified);
    assert_eq!(fs::read_to_string(cwd.join("a.js")).unwrap(), "new\n");
    context.observed_dirs.insert("gone".to_string());
    let error = call(
        "write",
        json!({ "path": "gone/x.txt", "content": "x" }),
        &mut context,
        default_limit(),
    )
    .error();
    assert_eq!(error, "gone/x.txt: its directory does not exist");
}

#[test]
fn bounds_start_formal_ai_max_file_bytes() {
    let bounds = |value: Option<&str>| {
        let value = value.map(str::to_string);
        resolve_bounds_with(move |key| {
            (key == "START_FORMAL_AI_MAX_FILE_BYTES")
                .then(|| value.clone())
                .flatten()
        })
    };
    assert_eq!(bounds(None).unwrap().max_file_bytes, 1024 * 1024);
    assert_eq!(bounds(Some("4096")).unwrap().max_file_bytes, 4096);
    assert_eq!(bounds(None).unwrap().to_json()["maxFileBytes"], 1024 * 1024);
    for value in ["0", "-1", "abc", "67108864"] {
        assert!(bounds(Some(value)).is_err(), "{} must be refused", value);
    }
}

#[test]
fn rejects_malformed_arguments_before_any_decision() {
    let dir = tempfile::tempdir().unwrap();
    let mut context = PolicyContext::new(dir.path(), "workspace-write");
    let problem = call(
        "write",
        json!({ "path": "a.txt" }),
        &mut context,
        default_limit(),
    )
    .problem();
    assert!(problem.contains("content"), "{}", problem);
    assert!(!dir.path().join("a.txt").exists());
}
