//! Regression tests for issue #150:
//! "`$ --status` fabricates a detached session exit code from the command's own
//!  output (unanchored `Exit Code:` scan over the whole log)"
//!
//! The exit code of a detached session used to be derived from an unanchored
//! `Exit Code: N` scan over the whole session log, so any text the wrapped
//! command printed that merely contained that substring was indistinguishable
//! from the terminal footer `start` appends itself.
//!
//! The fix anchors the scan on the three-line footer block `start` writes
//! (separator / `Finished:` / `Exit Code:`) and only reads the tail of the log,
//! where the footer always is.
//!
//! Reference: https://github.com/link-foundation/start/issues/150

use start_command::execution_store::{ExecutionRecord, ExecutionRecordOptions, ExecutionStatus};
use start_command::{enrich_detached_status, read_exit_code_from_log};
use std::fs;
use tempfile::TempDir;

const SEPARATOR: &str = "==================================================";

fn real_footer(exit_code: i32) -> String {
    format!("\n{SEPARATOR}\nFinished: 2026-07-30 23:36:20.295\nExit Code: {exit_code}\n")
}

fn write_log(dir: &TempDir, content: &str) -> String {
    let log_path = dir.path().join("session.log");
    fs::write(&log_path, content).unwrap();
    log_path.to_string_lossy().to_string()
}

#[test]
fn test_ignores_exit_code_substring_in_command_output() {
    let dir = TempDir::new().unwrap();
    // Exactly the payload from the incident: an older session log dumped by
    // `rg -n` into the JSON output of the running command.
    let log_path = write_log(
        &dir,
        "{\"type\":\"item.completed\",\"item\":{\"aggregated_output\":\
         \"40-==================================================\\n41-Finished: 2026-07-28 20:04:52.316\\n42-Exit Code: 1\\n\",\
         \"exit_code\":0,\"status\":\"completed\"}}\n",
    );
    assert_eq!(read_exit_code_from_log(&log_path), None);
}

#[test]
fn test_ignores_bare_exit_code_line_without_footer_block() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(&dir, "Exit Code: 1\nstill running\n");
    assert_eq!(read_exit_code_from_log(&log_path), None);
}

#[test]
fn test_ignores_exit_code_in_the_middle_of_a_line() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(
        &dir,
        &format!("{SEPARATOR}\nFinished: now\nlog: Exit Code: 3\n"),
    );
    assert_eq!(read_exit_code_from_log(&log_path), None);
}

#[test]
fn test_reads_the_real_footer() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(&dir, &format!("hello\n{}", real_footer(0)));
    assert_eq!(read_exit_code_from_log(&log_path), Some(0));
}

#[test]
fn test_last_anchored_footer_wins() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(
        &dir,
        &format!(
            "{SEPARATOR}\nFinished: fake\nExit Code: 1\n{}",
            real_footer(0)
        ),
    );
    assert_eq!(read_exit_code_from_log(&log_path), Some(0));
}

#[test]
fn test_reads_crlf_and_negative_codes() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(
        &dir,
        &format!("{SEPARATOR}\r\nFinished: t\r\nExit Code: 137\r\n"),
    );
    assert_eq!(read_exit_code_from_log(&log_path), Some(137));

    let log_path = write_log(&dir, &real_footer(-1));
    assert_eq!(read_exit_code_from_log(&log_path), Some(-1));
}

#[test]
fn test_returns_none_without_footer_or_file() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(&dir, "still running, no footer yet\n");
    assert_eq!(read_exit_code_from_log(&log_path), None);
    assert_eq!(
        read_exit_code_from_log(&dir.path().join("missing.log").to_string_lossy()),
        None
    );
}

#[test]
fn test_finds_footer_at_the_end_of_a_large_log() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(
        &dir,
        &format!("{}\n{}", "x".repeat(2 * 1024 * 1024), real_footer(42)),
    );
    assert_eq!(read_exit_code_from_log(&log_path), Some(42));
}

#[test]
fn test_partial_first_line_of_the_tail_is_dropped() {
    let dir = TempDir::new().unwrap();
    // The separator is a line *continuation*: the line starts with the filler,
    // so it is not a footer even though the tail slice begins mid-line.
    let log_path = write_log(
        &dir,
        &format!(
            "{}{SEPARATOR}\nFinished: t\nExit Code: 7\n",
            "y".repeat(32 * 1024)
        ),
    );
    assert_eq!(read_exit_code_from_log(&log_path), None);
}

fn make_absent_docker_record(log_path: &str) -> ExecutionRecord {
    let mut options = std::collections::HashMap::new();
    // A container name that cannot be inspected: liveness is unknown, the exact
    // window in which the incident happened.
    options.insert(
        "sessionName".to_string(),
        serde_json::Value::String(format!("issue150-absent-{}", std::process::id())),
    );
    options.insert(
        "isolated".to_string(),
        serde_json::Value::String("docker".to_string()),
    );
    options.insert(
        "isolationMode".to_string(),
        serde_json::Value::String("detached".to_string()),
    );
    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "solve.mjs".to_string(),
        log_path: Some(log_path.to_string()),
        options: Some(options),
        ..Default::default()
    })
}

#[test]
fn test_forged_output_does_not_terminate_an_executing_record() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(
        &dir,
        "{\"aggregated_output\":\"41-Finished: x\\n42-Exit Code: 1\\n\",\"exit_code\":0}\n",
    );
    let enriched = enrich_detached_status(&make_absent_docker_record(&log_path));
    assert_eq!(enriched.status, ExecutionStatus::Executing);
    assert_eq!(enriched.exit_code, None);
    assert!(enriched.end_time.is_none());
}

#[test]
fn test_genuine_footer_terminates_the_record() {
    let dir = TempDir::new().unwrap();
    let log_path = write_log(
        &dir,
        &format!(
            "{{\"aggregated_output\":\"42-Exit Code: 1\\n\"}}\n{}",
            real_footer(0)
        ),
    );
    let enriched = enrich_detached_status(&make_absent_docker_record(&log_path));
    assert_eq!(enriched.status, ExecutionStatus::Executed);
    assert_eq!(enriched.exit_code, Some(0));
    assert!(enriched.end_time.is_some());
}
