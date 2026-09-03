//! Regression tests for issue #165:
//! "Memory exhaustion reported by the runtime itself is invisible to `--status`"
//!
//! A runtime that aborts on its own heap limit (`FATAL ERROR: Reached heap
//! limit ...`) dies below the container limit, so every container signal
//! `start` consults is correct and useless: `State.OOMKilled` is `false` and
//! the cgroup `oom_kill` counter is `0`. The only evidence is what the runtime
//! printed into the log, which is why `--status` now carries `memoryExhausted`
//! / `memoryExhaustedReason` alongside `oomKilled`, and why the kept-container
//! footer no longer asserts a bare `oomKilled=false` next to a fatal marker.
//!
//! Reference: https://github.com/link-foundation/start/issues/165

use serde_json::Value;
use start_command::execution_store::{
    ExecutionRecord, ExecutionRecordOptions, ExecutionStore, ExecutionStoreOptions,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

const SEPARATOR: &str = "==================================================";
const HEAP_LIMIT_MARKER: &str =
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";

fn create_test_store(app_folder: &Path) -> ExecutionStore {
    ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(app_folder.to_path_buf()),
        use_links: Some(false),
        verbose: false,
    })
}

fn run_cli(app_folder: &Path, args: &[&str]) -> (String, String, i32) {
    let output = Command::new(env!("CARGO_BIN_EXE_start"))
        .args(args)
        .env("START_APP_FOLDER", app_folder)
        .env("START_DISABLE_AUTO_ISSUE", "1")
        .env("START_DISABLE_LOG_UPLOAD", "1")
        .output()
        .expect("failed to run the start binary");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

/// Write a log that ends the way the incident log does: command output, the
/// dying runtime's fatal marker, an optional native stack trace, and the
/// terminal footer `start` appends itself.
fn write_oom_log(dir: &Path, name: &str, marker: &str, stack_trace_bytes: usize) -> PathBuf {
    let log_path = dir.join(name);
    let frame = " 1: 0x757658 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]\n";
    let frames = frame.repeat(stack_trace_bytes.div_ceil(frame.len()));
    fs::write(
        &log_path,
        format!(
            "building...\n\n<--- Last few GCs --->\n{marker}\n----- Native stack trace -----\n\
             {frames}Docker container \"docker-165\" exited with code 139\n\
             Container kept because the command failed.\n\n{SEPARATOR}\n\
             Finished: 2026-09-03 08:14:20.707\nExit Code: 139\n"
        ),
    )
    .unwrap();
    log_path
}

fn save_record(store: &ExecutionStore, log_path: &Path, exit_code: i32) -> ExecutionRecord {
    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "node build.mjs".to_string(),
        pid: Some(4242),
        log_path: Some(log_path.to_string_lossy().to_string()),
        working_directory: Some("/tmp".to_string()),
        shell: Some("/bin/bash".to_string()),
        ..Default::default()
    });
    record.complete(exit_code);
    store.save(&record).unwrap();
    record
}

fn status_json(app_folder: &Path, uuid: &str) -> Value {
    let (stdout, stderr, exit_code) =
        run_cli(app_folder, &["--status", uuid, "--output-format", "json"]);
    assert_eq!(exit_code, 0, "stderr: {stderr}");
    serde_json::from_str(&stdout).unwrap()
}

#[test]
fn test_status_reports_memory_exhaustion_for_a_self_aborted_run() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let log_path = write_oom_log(temp.path(), "attached.log", HEAP_LIMIT_MARKER, 0);
    let record = save_record(&store, &log_path, 139);

    let parsed = status_json(temp.path(), &record.uuid);

    assert_eq!(parsed["exitCode"], 139);
    // The container flag is still absent/false - the observation does not
    // contradict it, it complements it.
    assert!(parsed.get("oomKilled").is_none() || parsed["oomKilled"].is_null());
    assert_eq!(parsed["memoryExhausted"], true);
    assert_eq!(parsed["memoryExhaustedReason"], HEAP_LIMIT_MARKER);
    assert_eq!(parsed["exitReason"], "memory-exhaustion (v8-heap-limit)");
}

#[test]
fn test_status_finds_a_marker_pushed_far_from_the_end_of_the_log() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let log_path = write_oom_log(temp.path(), "long-trace.log", HEAP_LIMIT_MARKER, 40 * 1024);
    assert!(fs::metadata(&log_path).unwrap().len() > 32 * 1024);
    let record = save_record(&store, &log_path, 134);

    let parsed = status_json(temp.path(), &record.uuid);

    assert_eq!(parsed["memoryExhausted"], true);
    assert_eq!(parsed["memoryExhaustedReason"], HEAP_LIMIT_MARKER);
}

#[test]
fn test_status_detects_a_rust_allocation_failure() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let marker = "memory allocation of 1073741824 bytes failed";
    let log_path = write_oom_log(temp.path(), "rust.log", marker, 0);
    let record = save_record(&store, &log_path, 134);

    let parsed = status_json(temp.path(), &record.uuid);

    assert_eq!(parsed["memoryExhausted"], true);
    assert_eq!(parsed["memoryExhaustedReason"], marker);
}

#[test]
fn test_status_never_turns_a_clean_run_into_a_memory_failure() {
    // The marker is present in the output - the command merely printed it -
    // but the run succeeded, so there is nothing to explain (issue #151's
    // rule: an observation, never a verdict).
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let log_path = temp.path().join("quoted.log");
    fs::write(
        &log_path,
        format!(
            "grep found: {HEAP_LIMIT_MARKER}\n{SEPARATOR}\n\
             Finished: 2026-09-03 08:14:20.707\nExit Code: 0\n"
        ),
    )
    .unwrap();
    let record = save_record(&store, &log_path, 0);

    let parsed = status_json(temp.path(), &record.uuid);

    assert_eq!(parsed["exitCode"], 0);
    assert!(parsed.get("memoryExhausted").is_none() || parsed["memoryExhausted"].is_null());
}

#[test]
fn test_status_leaves_an_ordinary_failure_without_a_memory_observation() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let log_path = temp.path().join("plain-failure.log");
    fs::write(&log_path, "error: missing file\n").unwrap();
    let record = save_record(&store, &log_path, 1);

    let parsed = status_json(temp.path(), &record.uuid);

    assert!(parsed.get("memoryExhausted").is_none() || parsed["memoryExhausted"].is_null());
}

#[test]
fn test_status_shows_the_observation_in_the_human_readable_output() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let log_path = write_oom_log(temp.path(), "formats.log", HEAP_LIMIT_MARKER, 0);
    let record = save_record(&store, &log_path, 139);

    let (stdout, stderr, exit_code) = run_cli(
        temp.path(),
        &["--status", &record.uuid, "--output-format", "text"],
    );

    assert_eq!(exit_code, 0, "stderr: {stderr}");
    assert!(
        stdout.contains("Memory Exhausted:  true"),
        "stdout: {stdout}"
    );
    assert!(
        stdout.contains(&format!("Memory Evidence:   {HEAP_LIMIT_MARKER}")),
        "stdout: {stdout}"
    );
}
