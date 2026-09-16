//! Regression tests for issue #170: detached Docker executions never persist a
//! terminal state, and `--status` fabricates `end_time` with the current clock.
//!
//! The three defects covered here:
//!   170.1 the detached completion watcher must write the terminal state back
//!         into the store instead of leaving the record `executing` forever;
//!   170.2 `--status` must derive `end_time` from a real clock
//!         (`State.FinishedAt` -> log footer `Finished:`) and mark the
//!         provenance via `end_time_source` when it falls back to observation
//!         time;
//!   170.3 `cleanup_stale()` must record `stale_detected_at`, not a fabricated
//!         finish time.

use chrono::{DateTime, Datelike, Utc};
use serde_json::Value;
use start_command::{
    enrich_detached_status, finalize_detached_execution, parse_footer_timestamp, CleanupOptions,
    DetachedFinalizeFacts, ExecutionRecord, ExecutionRecordOptions, ExecutionStatus,
    ExecutionStore, ExecutionStoreOptions,
};
use std::collections::HashMap;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tempfile::TempDir;

const CONTAINER_STARTED_AT: &str = "2026-09-15T22:21:40.942007645Z";
const CONTAINER_FINISHED_AT: &str = "2026-09-15T22:21:46.740817278Z";

fn detached_docker_record(log_path: &Path) -> ExecutionRecord {
    let mut options = HashMap::new();
    options.insert(
        "sessionName".to_string(),
        Value::String("start-command-170".to_string()),
    );
    options.insert("isolated".to_string(), Value::String("docker".to_string()));
    options.insert(
        "isolationMode".to_string(),
        Value::String("detached".to_string()),
    );

    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 100".to_string(),
        uuid: Some("issue170-rust".to_string()),
        status: Some(ExecutionStatus::Executing),
        log_path: Some(log_path.to_string_lossy().to_string()),
        start_time: Some("2026-09-15T22:21:40.000Z".to_string()),
        options: Some(options),
        ..Default::default()
    })
}

fn write_log_with_footer(dir: &Path, finished: &str, exit_code: i32) -> PathBuf {
    let log_path = dir.join("issue170.log");
    let content = format!(
        "output line\n{}\nFinished: {}\nExit Code: {}\n",
        "=".repeat(50),
        finished,
        exit_code
    );
    std::fs::write(&log_path, content).unwrap();
    log_path
}

/// A fake `docker` that answers every `inspect` with a fixed state line,
/// whatever the `-f` template asks for.
fn write_fake_docker(fake_dir: &Path, state_line: &str) -> PathBuf {
    write_docker_script(
        fake_dir,
        &[
            "#!/bin/sh".to_string(),
            "[ \"$1\" = \"inspect\" ] || exit 1".to_string(),
            format!("echo '{}'", state_line),
            String::new(),
        ]
        .join("\n"),
    )
}

/// A fake `docker` whose every `inspect` fails: the container is gone.
fn write_missing_container_docker(fake_dir: &Path) -> PathBuf {
    write_docker_script(fake_dir, "#!/bin/sh\nexit 1\n")
}

#[cfg(not(windows))]
fn write_docker_script(fake_dir: &Path, script: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let docker_path = fake_dir.join("docker");
    std::fs::write(&docker_path, script).unwrap();
    let mut permissions = std::fs::metadata(&docker_path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&docker_path, permissions).unwrap();
    docker_path
}

#[cfg(windows)]
fn write_docker_script(fake_dir: &Path, script: &str) -> PathBuf {
    // The POSIX bodies above are only ever used on unix hosts; on Windows the
    // shipped watcher shell does not run either, so a stub that always fails is
    // enough to keep the "container is gone" tests meaningful.
    let _ = script;
    let docker_path = fake_dir.join("docker.cmd");
    std::fs::write(&docker_path, "@echo off\r\nexit /b 1\r\n").unwrap();
    docker_path
}

fn with_fake_docker<F: FnOnce()>(write_docker: impl FnOnce(&Path) -> PathBuf, run: F) {
    static FAKE_DOCKER_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = FAKE_DOCKER_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fake_dir = TempDir::new().unwrap();
    let docker_path = write_docker(fake_dir.path());
    let original_docker_bin = std::env::var_os("START_DOCKER_BIN");
    std::env::set_var("START_DOCKER_BIN", &docker_path);
    let result = catch_unwind(AssertUnwindSafe(run));
    if let Some(path) = original_docker_bin {
        std::env::set_var("START_DOCKER_BIN", path);
    } else {
        std::env::remove_var("START_DOCKER_BIN");
    }
    if let Err(payload) = result {
        resume_unwind(payload);
    }
}

fn test_store(dir: &Path) -> ExecutionStore {
    ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.to_path_buf()),
        use_links: Some(false),
        verbose: false,
    })
}

// ---------------------------------------------------------------------------
// 170.2: end_time is never fabricated silently
// ---------------------------------------------------------------------------

#[test]
fn derives_end_time_from_docker_finished_at_for_a_stopped_container() {
    let temp = TempDir::new().unwrap();
    let log_path = write_log_with_footer(temp.path(), "2026-09-15 22:21:46.740", 137);
    let record = detached_docker_record(&log_path);

    with_fake_docker(
        |dir| {
            write_fake_docker(
                dir,
                &format!("false 137 false {CONTAINER_STARTED_AT} {CONTAINER_FINISHED_AT}"),
            )
        },
        || {
            let enriched = enrich_detached_status(&record);
            assert_eq!(enriched.status, ExecutionStatus::Executed);
            assert_eq!(enriched.exit_code, Some(137));
            assert_eq!(
                enriched.end_time_source.as_deref(),
                Some("docker-finished-at")
            );
            let end_time = DateTime::parse_from_rfc3339(enriched.end_time.as_deref().unwrap())
                .unwrap()
                .with_timezone(&Utc);
            assert_eq!(
                end_time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "2026-09-15T22:21:46.740Z"
            );
            assert_eq!(
                enriched.container_started_at.as_deref(),
                Some(CONTAINER_STARTED_AT)
            );
        },
    );
}

#[test]
fn falls_back_to_the_log_footer_finished_line_when_docker_is_gone() {
    let temp = TempDir::new().unwrap();
    let log_path = write_log_with_footer(temp.path(), "2026-09-15 22:21:46.740", 137);
    let record = detached_docker_record(&log_path);

    with_fake_docker(write_missing_container_docker, || {
        let enriched = enrich_detached_status(&record);
        assert_eq!(enriched.status, ExecutionStatus::Executed);
        assert_eq!(enriched.exit_code, Some(137));
        assert_eq!(enriched.end_time_source.as_deref(), Some("log-footer"));
        let end_time = DateTime::parse_from_rfc3339(enriched.end_time.as_deref().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            end_time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "2026-09-15T22:21:46.740Z"
        );
    });
}

#[test]
fn marks_the_observation_time_fallback_instead_of_pretending_it_is_a_finish_time() {
    let temp = TempDir::new().unwrap();
    let log_path = write_log_with_footer(temp.path(), "not-a-timestamp", 3);
    let record = detached_docker_record(&log_path);

    with_fake_docker(write_missing_container_docker, || {
        let enriched = enrich_detached_status(&record);
        assert_eq!(enriched.status, ExecutionStatus::Executed);
        assert_eq!(enriched.exit_code, Some(3));
        assert_eq!(enriched.end_time_source.as_deref(), Some("observed-at"));
        assert_eq!(enriched.observed_at, enriched.end_time);
    });
}

#[test]
fn keeps_an_already_recorded_end_time_and_its_provenance() {
    let temp = TempDir::new().unwrap();
    let log_path = write_log_with_footer(temp.path(), "2026-09-15 22:21:46.740", 0);
    let mut record = detached_docker_record(&log_path);
    record.status = ExecutionStatus::Executed;
    record.exit_code = Some(0);
    record.end_time = Some("2026-09-15T22:21:46.740Z".to_string());
    record.end_time_source = Some("docker-finished-at".to_string());

    with_fake_docker(
        |dir| {
            write_fake_docker(
                dir,
                "false 0 false 0001-01-01T00:00:00Z 0001-01-01T00:00:00Z",
            )
        },
        || {
            let enriched = enrich_detached_status(&record);
            assert_eq!(
                enriched.end_time.as_deref(),
                Some("2026-09-15T22:21:46.740Z")
            );
            assert_eq!(
                enriched.end_time_source.as_deref(),
                Some("docker-finished-at")
            );
        },
    );
}

#[test]
fn rejects_footer_timestamps_that_are_not_real_timestamps() {
    assert!(parse_footer_timestamp("not-a-timestamp").is_none());
    assert!(parse_footer_timestamp("").is_none());
    assert_eq!(
        parse_footer_timestamp("2026-09-15 22:21:46.740").as_deref(),
        Some("2026-09-15T22:21:46.740+00:00")
    );
}

// ---------------------------------------------------------------------------
// 170.3: cleanup_stale records the detection time
// ---------------------------------------------------------------------------

#[test]
fn cleanup_stale_sets_stale_detected_at_and_leaves_end_time_unknown() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());

    let mut record = ExecutionRecord::new("sleep 1000");
    record.start_time = (Utc::now() - chrono::Duration::hours(48)).to_rfc3339();
    store.save(&record).unwrap();

    let result = store.cleanup_stale(CleanupOptions {
        dry_run: false,
        ..Default::default()
    });
    assert_eq!(result.cleaned, 1);

    let cleaned = store.get(&record.uuid).unwrap();
    assert_eq!(cleaned.status, ExecutionStatus::Executed);
    assert_eq!(cleaned.exit_code, Some(-1));
    assert!(cleaned.end_time.is_none());
    let detected = cleaned.stale_detected_at.expect("stale_detected_at");
    assert!(DateTime::parse_from_rfc3339(&detected).is_ok());
}

// ---------------------------------------------------------------------------
// 170.1: the detached watcher persists the terminal state
// ---------------------------------------------------------------------------

#[test]
fn finalize_writes_status_exit_code_end_time_and_provenance_into_the_store() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let log_path = write_log_with_footer(temp.path(), "2026-09-15 22:21:46.740", 137);
    let record = detached_docker_record(&log_path);
    store.save(&record).unwrap();

    let outcome = finalize_detached_execution(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "137".to_string(),
            oom_killed: "false".to_string(),
            started_at: CONTAINER_STARTED_AT.to_string(),
            finished_at: CONTAINER_FINISHED_AT.to_string(),
            container_error: String::new(),
        },
    );
    assert!(outcome.updated, "reason: {}", outcome.reason);

    let stored = store.get(&record.uuid).unwrap();
    assert_eq!(stored.status, ExecutionStatus::Executed);
    assert_eq!(stored.exit_code, Some(137));
    assert_eq!(stored.oom_killed, Some(false));
    assert_eq!(
        stored.end_time_source.as_deref(),
        Some("docker-finished-at")
    );
    let end_time = DateTime::parse_from_rfc3339(stored.end_time.as_deref().unwrap()).unwrap();
    assert_eq!(
        end_time
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "2026-09-15T22:21:46.740Z"
    );
    assert!(stored.exit_reason.unwrap().contains("SIGKILL"));
}

#[test]
fn finalize_falls_back_to_observation_time_when_docker_reports_no_finish_time() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let log_path = write_log_with_footer(temp.path(), "2026-09-15 22:21:46.740", 0);
    let record = detached_docker_record(&log_path);
    store.save(&record).unwrap();

    finalize_detached_execution(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "0".to_string(),
            oom_killed: "false".to_string(),
            started_at: "unknown".to_string(),
            // The docker zero-time sentinel must never reach a record.
            finished_at: "0001-01-01T00:00:00Z".to_string(),
            container_error: String::new(),
        },
    );

    let stored = store.get(&record.uuid).unwrap();
    assert_eq!(stored.status, ExecutionStatus::Executed);
    assert_eq!(stored.exit_code, Some(0));
    assert_eq!(stored.end_time_source.as_deref(), Some("observed-at"));
    assert_eq!(stored.observed_at, stored.end_time);
    let end_time = DateTime::parse_from_rfc3339(stored.end_time.as_deref().unwrap()).unwrap();
    assert!(end_time.year() > 2000);
}

#[test]
fn finalize_never_fails_when_the_record_is_gone() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let outcome = finalize_detached_execution(
        &store,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        &DetachedFinalizeFacts {
            exit_code: "1".to_string(),
            oom_killed: "false".to_string(),
            started_at: String::new(),
            finished_at: String::new(),
            container_error: String::new(),
        },
    );
    assert!(!outcome.updated);
    assert_eq!(outcome.reason, "record-not-found");
}
