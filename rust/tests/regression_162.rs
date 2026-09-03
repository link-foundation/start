//! Regression tests for issue #162:
//! "Docker isolation: no way to attach to, resume, or re-enter a detached
//!  session — and no way to resume all running commands after a supervisor
//!  restart"
//!
//! A detached docker session used to be a dead end: once it stopped there was
//! no way to re-enter it, continue it, or run a different command inside the
//! same container, and a supervisor restart left records stuck in "executing"
//! forever. `exitCode 139` with `oomKilled false` also hid the real cause.
//!
//! These tests drive the CLI end to end, so they cover the wiring between the
//! argument parser, the execution store and the new attach/resume verbs.
//!
//! Reference: https://github.com/link-foundation/start/issues/162

use serde_json::Value;
use start_command::execution_store::{
    ExecutionRecord, ExecutionRecordOptions, ExecutionStore, ExecutionStoreOptions,
};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

const SEPARATOR: &str = "==================================================";

struct CliResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

fn create_test_store(app_folder: &Path) -> ExecutionStore {
    ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(app_folder.to_path_buf()),
        use_links: Some(false),
        verbose: false,
    })
}

fn run_cli(app_folder: &Path, args: &[&str]) -> CliResult {
    let output = Command::new(env!("CARGO_BIN_EXE_start"))
        .args(args)
        .env("START_APP_FOLDER", app_folder)
        .env("START_DISABLE_AUTO_ISSUE", "1")
        .env("START_DISABLE_LOG_UPLOAD", "1")
        .output()
        .expect("failed to run the start binary");

    CliResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    }
}

fn save_record(
    store: &ExecutionStore,
    command: &str,
    log_path: Option<&str>,
    exit_code: Option<i32>,
    options: &[(&str, Value)],
) -> ExecutionRecord {
    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: command.to_string(),
        pid: Some(4242),
        log_path: log_path.map(str::to_string),
        working_directory: Some("/tmp".to_string()),
        shell: Some("/bin/bash".to_string()),
        options: Some(
            options
                .iter()
                .map(|(key, value)| (key.to_string(), value.clone()))
                .collect::<HashMap<_, _>>(),
        ),
        ..Default::default()
    });
    if let Some(code) = exit_code {
        record.complete(code);
    }
    store.save(&record).unwrap();
    record
}

fn detached_docker_options(session_name: &str) -> Vec<(&'static str, Value)> {
    vec![
        ("isolated", Value::String("docker".to_string())),
        ("isolationMode", Value::String("detached".to_string())),
        ("sessionName", Value::String(session_name.to_string())),
    ]
}

// ===== --list --running =====

#[test]
fn test_list_running_reports_only_executions_that_are_still_running() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let finished = save_record(&store, "echo finished", None, Some(0), &[]);
    let running = save_record(&store, "echo running", None, None, &[]);

    let result = run_cli(
        temp.path(),
        &["--list", "--running", "--output-format", "json"],
    );

    assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
    let parsed: Value = serde_json::from_str(&result.stdout).unwrap();
    let uuids: Vec<&str> = parsed["executions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|record| record["uuid"].as_str().unwrap())
        .collect();
    assert!(uuids.contains(&running.uuid.as_str()));
    assert!(!uuids.contains(&finished.uuid.as_str()));
}

#[test]
fn test_running_is_rejected_without_list() {
    let temp = TempDir::new().unwrap();
    let result = run_cli(temp.path(), &["--running", "--", "echo", "hi"]);

    assert_ne!(result.exit_code, 0);
    assert!(
        result
            .stderr
            .contains("--running option is only valid with --list"),
        "stderr: {}",
        result.stderr
    );
}

// ===== --attach =====

#[test]
fn test_attach_fails_with_a_clear_error_for_an_unknown_identifier() {
    let temp = TempDir::new().unwrap();
    create_test_store(temp.path());
    let result = run_cli(temp.path(), &["--attach", "does-not-exist"]);

    assert_eq!(result.exit_code, 1);
    assert!(
        result
            .stderr
            .contains("No execution found with UUID or session name: does-not-exist"),
        "stderr: {}",
        result.stderr
    );
}

#[test]
fn test_attach_refuses_a_non_isolated_execution() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let record = save_record(&store, "echo local", None, None, &[]);

    let result = run_cli(temp.path(), &["--attach", &record.uuid]);

    assert_eq!(result.exit_code, 1);
    assert!(
        result
            .stderr
            .contains("Execution record does not contain an isolation session name"),
        "stderr: {}",
        result.stderr
    );
}

#[test]
fn test_attach_points_at_resume_when_the_session_is_already_gone() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let record = save_record(
        &store,
        "echo gone",
        None,
        None,
        &detached_docker_options("start-command-162-missing"),
    );

    let result = run_cli(temp.path(), &["--attach", &record.uuid]);

    assert_eq!(result.exit_code, 1);
    assert!(
        result.stderr.contains("--resume"),
        "stderr: {}",
        result.stderr
    );
}

#[test]
fn test_read_only_is_rejected_without_attach() {
    let temp = TempDir::new().unwrap();
    let result = run_cli(temp.path(), &["--read-only", "--", "echo", "hi"]);

    assert_ne!(result.exit_code, 0);
    assert!(
        result
            .stderr
            .contains("--read-only option is only valid with --attach"),
        "stderr: {}",
        result.stderr
    );
}

// ===== --resume =====

#[test]
fn test_resume_fails_with_a_clear_error_for_an_unknown_identifier() {
    let temp = TempDir::new().unwrap();
    create_test_store(temp.path());
    let result = run_cli(temp.path(), &["--resume", "does-not-exist"]);

    assert_eq!(result.exit_code, 1);
    assert!(
        result
            .stderr
            .contains("No execution found with UUID or session name: does-not-exist"),
        "stderr: {}",
        result.stderr
    );
}

#[test]
fn test_resume_refuses_a_non_isolated_execution() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let record = save_record(&store, "echo local", None, None, &[]);

    let result = run_cli(temp.path(), &["--resume", &record.uuid]);

    assert_eq!(result.exit_code, 1);
    assert!(
        result
            .stderr
            .contains("Execution record does not contain an isolation session name"),
        "stderr: {}",
        result.stderr
    );
}

#[test]
fn test_resume_accepts_a_replacement_command_after_the_separator() {
    let temp = TempDir::new().unwrap();
    create_test_store(temp.path());
    // The identifier is still resolved first, so this reports the missing
    // record rather than treating "echo hi" as a fresh command.
    let result = run_cli(
        temp.path(),
        &["--resume", "does-not-exist", "--", "echo", "hi"],
    );

    assert_eq!(result.exit_code, 1);
    assert!(
        result
            .stderr
            .contains("No execution found with UUID or session name: does-not-exist"),
        "stderr: {}",
        result.stderr
    );
}

// ===== --resume-all =====

#[test]
fn test_resume_all_succeeds_with_an_empty_report_when_nothing_is_running() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    save_record(&store, "echo finished", None, Some(0), &[]);

    let result = run_cli(temp.path(), &["--resume-all", "--output-format", "json"]);

    assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
    let parsed: Value = serde_json::from_str(&result.stdout).unwrap();
    assert_eq!(parsed["count"], 0);
    assert_eq!(parsed["executions"].as_array().unwrap().len(), 0);
}

#[test]
fn test_resume_all_reconciles_executions_whose_session_no_longer_exists() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let log_path = temp.path().join("orphan.log");
    fs::write(
        &log_path,
        format!("working...\n{SEPARATOR}\nFinished: 2026-09-03 10:00:00.000\nExit Code: 0\n"),
    )
    .unwrap();
    let record = save_record(
        &store,
        "echo orphan",
        Some(log_path.to_str().unwrap()),
        None,
        &detached_docker_options("start-command-162-orphan"),
    );

    let result = run_cli(temp.path(), &["--resume-all", "--output-format", "json"]);

    assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
    let parsed: Value = serde_json::from_str(&result.stdout).unwrap();
    assert_eq!(parsed["count"], 1);
    assert_eq!(parsed["executions"][0]["uuid"], record.uuid);
    assert_eq!(parsed["executions"][0]["action"], "reconciled");

    // The stuck "executing" record is now finalized in the store.
    let reloaded = create_test_store(temp.path()).get(&record.uuid).unwrap();
    assert_eq!(reloaded.status.as_str(), "executed");
}

// ===== exit reason hint =====

#[test]
fn test_status_explains_a_139_exit_caused_by_heap_exhaustion() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let log_path = temp.path().join("oom.log");
    fs::write(
        &log_path,
        format!(
            "building...\n\n<--- Last few GCs --->\nFATAL ERROR: Reached heap limit \
             Allocation failed - JavaScript heap out of memory\n\n{SEPARATOR}\n\
             Finished: 2026-09-03 10:00:00.000\nExit Code: 139\n"
        ),
    )
    .unwrap();
    let record = save_record(
        &store,
        "bun run build",
        Some(log_path.to_str().unwrap()),
        Some(139),
        &[],
    );

    let result = run_cli(
        temp.path(),
        &["--status", &record.uuid, "--output-format", "json"],
    );

    assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
    let parsed: Value = serde_json::from_str(&result.stdout).unwrap();
    assert_eq!(parsed["exitCode"], 139);
    assert!(parsed.get("oomKilled").is_none() || parsed["oomKilled"].is_null());
    assert_eq!(parsed["exitReason"], "memory-exhaustion (v8-heap-limit)");
}

#[test]
fn test_status_does_not_invent_a_reason_for_a_clean_exit() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let log_path = temp.path().join("clean.log");
    fs::write(&log_path, "all good\n").unwrap();
    let record = save_record(
        &store,
        "echo ok",
        Some(log_path.to_str().unwrap()),
        Some(0),
        &[],
    );

    let result = run_cli(
        temp.path(),
        &["--status", &record.uuid, "--output-format", "json"],
    );

    assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
    let parsed: Value = serde_json::from_str(&result.stdout).unwrap();
    assert!(parsed.get("exitReason").is_none() || parsed["exitReason"].is_null());
}

// ===== session identity across resumes =====

#[test]
fn test_status_keeps_addressing_one_logical_session_by_its_previous_name() {
    let temp = TempDir::new().unwrap();
    let store = create_test_store(temp.path());
    let mut options = detached_docker_options("start-command-162-b");
    options.push((
        "sessionNameHistory",
        Value::Array(vec![Value::String("start-command-162-a".to_string())]),
    ));
    let record = save_record(&store, "echo resumed", None, None, &options);

    let result = run_cli(
        temp.path(),
        &["--status", "start-command-162-a", "--output-format", "json"],
    );

    assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
    let parsed: Value = serde_json::from_str(&result.stdout).unwrap();
    assert_eq!(parsed["uuid"], record.uuid);
}
