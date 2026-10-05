//! Regression tests for issue #180: `$ --status` reported `exitReason
//! memory-exhaustion (cgroup-oom-killer)` and `memoryExhausted true` for an
//! ordinary exit 0/1 whenever Docker's `State.OOMKilled` flag was set. Since
//! moby/moby#43564 that flag is container-wide and sticky: it turns on as soon
//! as *any* process in the container is OOM-killed (a `rustc` child under
//! `cargo test`) and stays on until the container starts again. A command that
//! survived that and later exited 1 on its own was reported as having run out
//! of memory.
//!
//! The flag only explains the command's exit when that exit is 137
//! (`128 + SIGKILL`) or unknown: the rule `is_killed_exit` applies since #178.

use serde_json::Value;
use start_command::exit_reason::{
    is_oom_kill_of_command, resolve_memory_exhaustion, CGROUP_OOM_EXIT_REASON,
};
use start_command::{
    enrich_detached_status, finalize_detached_execution, resolve_exit_reason,
    DetachedFinalizeFacts, ExecutionRecord, ExecutionRecordOptions, ExecutionStatus,
    ExecutionStore, ExecutionStoreOptions,
};
use std::collections::HashMap;
use std::path::Path;
use tempfile::TempDir;

const OOM_REASON: &str = "Docker reported State.OOMKilled=true";

/// `(exit_code, oom_killed, exit_reason, memory_exhausted)`: the reproduction
/// table from the issue, plus the watcher's unknown exit and a non-SIGKILL
/// signal.
const CASES: [(i32, bool, Option<&str>, bool); 7] = [
    (0, true, None, false),
    (1, true, None, false),
    (1, false, None, false),
    (137, true, Some(CGROUP_OOM_EXIT_REASON), true),
    (137, false, Some("signal (SIGKILL)"), false),
    (-1, true, Some(CGROUP_OOM_EXIT_REASON), true),
    (139, true, Some("signal (SIGSEGV)"), false),
];

#[test]
fn the_sticky_flag_is_an_exit_reason_only_for_sigkill_or_an_unknown_exit() {
    for (exit_code, oom_killed, reason, memory) in CASES {
        assert_eq!(
            resolve_exit_reason(Some(exit_code), None, Some(oom_killed), None).as_deref(),
            reason,
            "exit={} oom={}",
            exit_code,
            oom_killed
        );
        let observed = resolve_memory_exhaustion(Some(exit_code), None, Some(oom_killed), None);
        assert_eq!(
            observed
                .as_ref()
                .map(|m| m.memory_exhausted_reason.as_str()),
            if memory { Some(OOM_REASON) } else { None },
            "exit={} oom={}",
            exit_code,
            oom_killed
        );
    }
}

#[test]
fn blames_the_flag_on_the_command_only_for_sigkill_or_an_unknown_exit() {
    assert!(is_oom_kill_of_command(Some(137), Some(true), None));
    assert!(is_oom_kill_of_command(None, Some(true), None));
    assert!(is_oom_kill_of_command(Some(-1), Some(true), None));
    assert!(!is_oom_kill_of_command(Some(0), Some(true), None));
    assert!(!is_oom_kill_of_command(Some(1), Some(true), None));
    assert!(!is_oom_kill_of_command(Some(137), Some(false), None));
    assert!(!is_oom_kill_of_command(Some(137), None, None));
}

#[test]
fn still_trusts_a_memory_marker_the_command_printed_itself() {
    let tail = "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";
    assert_eq!(
        resolve_exit_reason(Some(1), Some(tail), Some(true), None).as_deref(),
        Some("memory-exhaustion (v8-heap-limit)")
    );
    assert!(resolve_memory_exhaustion(Some(1), Some(tail), Some(true), None).is_some());
}

fn test_store(dir: &Path) -> ExecutionStore {
    ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.to_path_buf()),
        use_links: Some(false),
        verbose: false,
    })
}

fn finished_record(exit_reason: Option<&str>) -> ExecutionRecord {
    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "cargo test".to_string(),
        status: Some(ExecutionStatus::Executed),
        ..Default::default()
    });
    record.exit_code = Some(1);
    record.oom_killed = Some(true);
    record.exit_reason = exit_reason.map(str::to_string);
    record
}

#[test]
fn status_reports_the_incident_record_without_a_memory_verdict() {
    let enriched = enrich_detached_status(&finished_record(None));
    assert_eq!(enriched.oom_killed, Some(true));
    assert_eq!(enriched.exit_reason, None);
    assert_eq!(enriched.memory_exhausted, None);
}

#[test]
fn status_drops_a_stale_cgroup_reason_stored_before_the_fix() {
    let enriched = enrich_detached_status(&finished_record(Some(CGROUP_OOM_EXIT_REASON)));
    assert_eq!(enriched.exit_reason, None);
}

#[test]
fn the_finalizer_does_not_record_the_flag_as_the_reason_for_exit_1() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let mut options = HashMap::new();
    options.insert("isolated".to_string(), Value::String("docker".to_string()));
    options.insert(
        "isolationMode".to_string(),
        Value::String("detached".to_string()),
    );
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "cargo test".to_string(),
        status: Some(ExecutionStatus::Executing),
        options: Some(options),
        ..Default::default()
    });
    store.save(&record).unwrap();

    finalize_detached_execution(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "1".to_string(),
            oom_killed: "true".to_string(),
            started_at: "2026-10-01T19:00:00Z".to_string(),
            finished_at: "2026-10-01T19:41:00Z".to_string(),
            container_error: String::new(),
            running: "false".to_string(),
            ..Default::default()
        },
    );

    let stored = store.get(&record.uuid).unwrap();
    assert_eq!(stored.exit_code, Some(1));
    assert_eq!(stored.oom_killed, Some(true));
    assert_eq!(stored.exit_reason, None);
}
