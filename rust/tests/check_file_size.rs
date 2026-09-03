//! Behaviour of `scripts/check-file-size.mjs` (issue #168).
//!
//! The 1000-line limit is a refactoring rule for this repository's own source.
//! It fired on `dev/log/issues/168/pulls/169/upstream/use-m-8.15.1-use.js` - a
//! third-party file archived verbatim as investigation evidence - and failed
//! both the JavaScript and the Rust pipeline. That is a false positive: the
//! archive cannot be refactored without destroying the evidence it preserves.
//!
//! This mirrors `js/test/check-file-size.js`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// Run the checker over a throwaway tree of `(relative path, line count)`.
fn run_checker(name: &str, files: &[(&str, usize)]) -> (i32, String) {
    let dir = std::env::temp_dir().join(format!("check-file-size-{name}"));
    let _ = fs::remove_dir_all(&dir);
    for (relative_path, lines) in files {
        let full = dir.join(relative_path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, "const x = 1;\n".repeat(*lines)).unwrap();
    }

    let output = Command::new("node")
        .arg(repo_root().join("scripts").join("check-file-size.mjs"))
        .current_dir(&dir)
        .output()
        .expect("node is available");
    let _ = fs::remove_dir_all(&dir);

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.code().unwrap_or(-1), text)
}

#[test]
fn fails_on_an_oversized_file_in_the_repository_source() {
    let (code, output) = run_checker("oversized", &[("scripts/huge.mjs", 1500)]);
    assert_eq!(code, 1, "{output}");
    assert!(output.contains("scripts/huge.mjs"), "{output}");
}

#[test]
fn passes_when_every_file_is_within_the_limit() {
    let (code, output) = run_checker("within", &[("scripts/small.mjs", 10)]);
    assert_eq!(code, 0, "{output}");
    assert!(output.contains("within the line limit"), "{output}");
}

#[test]
fn ignores_archived_evidence_under_dev_log() {
    let (code, output) = run_checker(
        "archived",
        &[
            ("dev/log/issues/168/pulls/169/upstream/vendored.js", 1500),
            ("scripts/small.mjs", 10),
        ],
    );
    assert_eq!(code, 0, "{output}");
    assert!(!output.contains("vendored.js"), "{output}");
}

#[test]
fn still_checks_rust_sources_outside_the_archive() {
    let (code, output) = run_checker("rust-source", &[("rust/src/huge.rs", 1500)]);
    assert_eq!(code, 1, "{output}");
    assert!(output.contains("rust/src/huge.rs"), "{output}");
}
