//! Tests for --status lookup by session name and detached status enrichment
//! Issue #101: --session name not usable with --status, and --detached reports immediate completion
//! Issue #105: currentTime added to --status output for executing commands

use start_command::{
    attach_current_time, enrich_detached_status, is_detached_session_alive, query_status,
    ExecutionRecord, ExecutionRecordOptions, ExecutionStatus, ExecutionStore,
    ExecutionStoreOptions,
};
use std::collections::HashMap;
use tempfile::TempDir;

/// Helper to create a test store in a temporary directory
fn create_test_store() -> (TempDir, ExecutionStore) {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    (temp_dir, store)
}

/// Helper to create isolation options with session name
fn make_isolation_options(
    session_name: &str,
    isolated: &str,
    isolation_mode: &str,
) -> HashMap<String, serde_json::Value> {
    let mut opts = HashMap::new();
    opts.insert(
        "sessionName".to_string(),
        serde_json::Value::String(session_name.to_string()),
    );
    opts.insert(
        "isolated".to_string(),
        serde_json::Value::String(isolated.to_string()),
    );
    opts.insert(
        "isolationMode".to_string(),
        serde_json::Value::String(isolation_mode.to_string()),
    );
    opts
}

// ===== ExecutionStore::get() session name lookup tests =====

#[test]
fn test_get_by_uuid() {
    let (_temp_dir, store) = create_test_store();

    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo hello".to_string(),
        uuid: Some("test-uuid-session-101".to_string()),
        pid: Some(12345),
        options: Some(make_isolation_options("my-session", "screen", "attached")),
        ..Default::default()
    });
    record.complete(0);
    store.save(&record).unwrap();

    let found = store.get("test-uuid-session-101");
    assert!(found.is_some());
    assert_eq!(found.unwrap().uuid, "test-uuid-session-101");
}

#[test]
fn test_get_by_session_name() {
    let (_temp_dir, store) = create_test_store();

    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        uuid: Some("uuid-for-session-lookup-test".to_string()),
        pid: Some(12345),
        options: Some(make_isolation_options(
            "my-custom-session",
            "screen",
            "detached",
        )),
        ..Default::default()
    });
    store.save(&record).unwrap();

    let found = store.get("my-custom-session");
    assert!(found.is_some());
    let found = found.unwrap();
    assert_eq!(found.uuid, "uuid-for-session-lookup-test");
    assert_eq!(
        found.options.get("sessionName").unwrap().as_str().unwrap(),
        "my-custom-session"
    );
}

#[test]
fn test_get_prefers_uuid_over_session_name() {
    let (_temp_dir, store) = create_test_store();

    // Record 1 with a specific UUID
    let mut record1 = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo first".to_string(),
        uuid: Some("target-uuid-101".to_string()),
        pid: Some(111),
        options: Some(make_isolation_options("some-session", "screen", "attached")),
        ..Default::default()
    });
    record1.complete(0);
    store.save(&record1).unwrap();

    // Record 2 whose session name matches record1's UUID
    let record2 = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo second".to_string(),
        uuid: Some("other-uuid-101".to_string()),
        pid: Some(222),
        options: Some(make_isolation_options(
            "target-uuid-101",
            "screen",
            "detached",
        )),
        ..Default::default()
    });
    store.save(&record2).unwrap();

    // Looking up by record1's UUID should return record1, not record2
    let found = store.get("target-uuid-101").unwrap();
    assert_eq!(found.command, "echo first");
}

#[test]
fn test_get_nonexistent_session_name() {
    let (_temp_dir, store) = create_test_store();

    let found = store.get("nonexistent-session");
    assert!(found.is_none());
}

#[test]
fn test_get_record_without_session_name() {
    let (_temp_dir, store) = create_test_store();

    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo hello".to_string(),
        uuid: Some("no-session-name-uuid".to_string()),
        pid: Some(12345),
        ..Default::default()
    });
    store.save(&record).unwrap();

    let found = store.get("some-session-name");
    assert!(found.is_none());
}

// ===== query_status() with session name tests =====

#[test]
fn test_query_status_by_session_name() {
    let (_temp_dir, store) = create_test_store();

    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        uuid: Some("query-session-uuid-101".to_string()),
        pid: Some(12345),
        options: Some(make_isolation_options(
            "my-query-session",
            "screen",
            "attached",
        )),
        ..Default::default()
    });
    record.complete(0);
    store.save(&record).unwrap();

    let result = query_status(Some(&store), "my-query-session", Some("json"));
    assert!(result.success);
    let output = result.output.unwrap();
    assert!(output.contains("query-session-uuid-101"));
    assert!(output.contains("sleep 60"));
}

#[test]
fn test_query_status_nonexistent_session_name() {
    let (_temp_dir, store) = create_test_store();

    let result = query_status(Some(&store), "nonexistent-session", Some("json"));
    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("No execution found with UUID or session name"));
}

// ===== Detached status enrichment tests =====

#[test]
fn test_is_detached_session_alive_non_detached() {
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo hello".to_string(),
        options: Some(make_isolation_options("test", "screen", "attached")),
        ..Default::default()
    });
    assert!(is_detached_session_alive(&record).is_none());
}

#[test]
fn test_is_detached_session_alive_no_session_name() {
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo hello".to_string(),
        ..Default::default()
    });
    assert!(is_detached_session_alive(&record).is_none());
}

#[test]
fn test_is_detached_session_alive_nonexistent_screen() {
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        options: Some(make_isolation_options(
            "nonexistent-screen-session-test-101",
            "screen",
            "detached",
        )),
        ..Default::default()
    });
    let alive = is_detached_session_alive(&record);
    // May be Some(false) or None depending on whether screen is installed
    if let Some(v) = alive {
        assert!(!v);
    }
}

#[test]
fn test_enrich_detached_status_non_detached() {
    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo hello".to_string(),
        options: Some(make_isolation_options("test", "screen", "attached")),
        ..Default::default()
    });
    record.complete(0);

    let enriched = enrich_detached_status(&record);
    assert_eq!(enriched.status, ExecutionStatus::Executed);
    assert_eq!(enriched.exit_code, Some(0));
}

#[test]
fn test_enrich_detached_status_marks_dead_session_as_executed() {
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        options: Some(make_isolation_options(
            "nonexistent-session-enrich-101",
            "screen",
            "detached",
        )),
        ..Default::default()
    });
    // Record says executing, but session doesn't exist

    let enriched = enrich_detached_status(&record);
    // If screen is available, should mark as executed with exit code -1
    if enriched.status == ExecutionStatus::Executed {
        assert_eq!(enriched.exit_code, Some(-1));
        assert!(enriched.end_time.is_some());
    }
}

// ===== Issue #134: lingering live session must not resurrect a completed record =====

/// Probe whether `screen` is usable in this environment.
fn screen_available() -> bool {
    std::process::Command::new("screen")
        .arg("-v")
        .output()
        .map(|o| {
            o.status.success() || String::from_utf8_lossy(&o.stdout).contains("Screen version")
        })
        .unwrap_or(false)
}

/// Start a detached screen session that outlives the (already-finished) command.
/// Returns the session name. Caller must quit it.
fn start_lingering_screen(session_name: &str) {
    let _ = std::process::Command::new("screen")
        .args(["-dmS", session_name, "sh", "-c", "sleep 30"])
        .output();
}

/// Whether the lingering session is observable as alive in this environment.
///
/// Some instrumented environments (notably `cargo tarpaulin`, which traces
/// every fork via ptrace) disrupt the `screen -dmS` daemon fork, so the
/// session never registers in `screen -ls`. There the sanity precondition for
/// these tests cannot hold, so they skip rather than fail.
fn session_observably_alive(record: &ExecutionRecord) -> bool {
    is_detached_session_alive(record) == Some(true)
}

fn quit_screen(session_name: &str) {
    let _ = std::process::Command::new("screen")
        .args(["-S", session_name, "-X", "quit"])
        .output();
}

#[test]
fn test_enrich_keeps_recorded_exit_code_when_session_lingers() {
    if !screen_available() {
        return;
    }
    let temp_dir = TempDir::new().unwrap();
    let session_name = format!("enrich-134-recorded-{}", std::process::id());
    let log_path = temp_dir.path().join(format!("{session_name}.log"));
    // Footer exactly as `start` writes it for a SIGKILLed command.
    std::fs::write(
        &log_path,
        "Killed\n\n==================================================\nFinished: 2026-06-14 19:10:49.822\nExit Code: 137\n",
    )
    .unwrap();

    start_lingering_screen(&session_name);

    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        log_path: Some(log_path.to_string_lossy().to_string()),
        options: Some(make_isolation_options(&session_name, "screen", "detached")),
        ..Default::default()
    });
    record.complete(137);

    // Sanity: the session must actually be alive for this test to be meaningful.
    if !session_observably_alive(&record) {
        quit_screen(&session_name);
        return;
    }

    let enriched = enrich_detached_status(&record);
    quit_screen(&session_name);

    assert_eq!(enriched.status, ExecutionStatus::Executed);
    assert_eq!(enriched.exit_code, Some(137));
    assert!(enriched.end_time.is_some());
}

#[test]
fn test_enrich_honors_log_footer_when_no_recorded_exit_code() {
    if !screen_available() {
        return;
    }
    let temp_dir = TempDir::new().unwrap();
    let session_name = format!("enrich-134-footer-{}", std::process::id());
    let log_path = temp_dir.path().join(format!("{session_name}.log"));
    std::fs::write(
        &log_path,
        "Killed\n\n==================================================\nFinished: 2026-06-14 19:10:49.822\nExit Code: 137\n",
    )
    .unwrap();

    start_lingering_screen(&session_name);

    // Status 'executed' but exit_code never recorded; the footer is authoritative.
    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        status: Some(ExecutionStatus::Executed),
        log_path: Some(log_path.to_string_lossy().to_string()),
        options: Some(make_isolation_options(&session_name, "screen", "detached")),
        ..Default::default()
    });
    record.exit_code = None;
    record.end_time = None;

    if !session_observably_alive(&record) {
        quit_screen(&session_name);
        return;
    }

    let enriched = enrich_detached_status(&record);
    quit_screen(&session_name);

    assert_eq!(enriched.status, ExecutionStatus::Executed);
}

#[test]
fn test_enrich_flips_to_executing_when_no_terminal_record() {
    if !screen_available() {
        return;
    }
    let temp_dir = TempDir::new().unwrap();
    let session_name = format!("enrich-134-nofooter-{}", std::process::id());
    let log_path = temp_dir.path().join(format!("{session_name}.log"));
    // Log with NO Exit Code footer.
    std::fs::write(&log_path, "still running, no footer yet\n").unwrap();

    start_lingering_screen(&session_name);

    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        status: Some(ExecutionStatus::Executed),
        log_path: Some(log_path.to_string_lossy().to_string()),
        options: Some(make_isolation_options(&session_name, "screen", "detached")),
        ..Default::default()
    });
    record.exit_code = None;
    record.end_time = None;

    if !session_observably_alive(&record) {
        quit_screen(&session_name);
        return;
    }

    let enriched = enrich_detached_status(&record);
    quit_screen(&session_name);

    assert_eq!(enriched.status, ExecutionStatus::Executing);
    assert_eq!(enriched.exit_code, None);
    assert!(enriched.end_time.is_none());
}

// ===== Issue #136: detached docker session must not report a terminal -1 while the container is still running =====

/// Probe whether `docker` is usable (CLI present and daemon reachable).
fn docker_available() -> bool {
    std::process::Command::new("docker")
        .arg("info")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn docker_rm(name: &str) {
    let _ = std::process::Command::new("docker")
        .args(["rm", "-f", name])
        .output();
}

/// A detached docker container that is not visible yet (still being created on a
/// slow Docker-in-Docker host) cannot be inspected. Its liveness must be
/// reported as `None` (unknown), NOT `Some(false)` — otherwise the enrich step
/// would mark the still-pending session terminal with the `-1` sentinel.
#[test]
fn test_is_detached_session_alive_unknown_docker_container_is_none() {
    if !docker_available() {
        return;
    }
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 120".to_string(),
        options: Some(make_isolation_options(
            "issue136-container-does-not-exist-yet",
            "docker",
            "detached",
        )),
        ..Default::default()
    });
    assert_eq!(is_detached_session_alive(&record), None);
}

/// Regression for issue #136: while a detached docker container is not yet
/// inspectable, the record must stay `executing` with `None` exit code rather
/// than flipping to `executed` / `-1`.
#[test]
fn test_enrich_keeps_executing_when_docker_container_not_visible() {
    if !docker_available() {
        return;
    }
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 120".to_string(),
        options: Some(make_isolation_options(
            "issue136-container-not-visible",
            "docker",
            "detached",
        )),
        ..Default::default()
    });
    // Record defaults to executing with no exit code.
    let enriched = enrich_detached_status(&record);
    assert_eq!(enriched.status, ExecutionStatus::Executing);
    assert_eq!(enriched.exit_code, None);
    assert!(enriched.end_time.is_none());
}

/// A genuinely running detached container reports `Some(true)` and stays
/// `executing`.
#[test]
fn test_enrich_running_docker_container_stays_executing() {
    if !docker_available() {
        return;
    }
    let name = format!("issue136-running-{}", std::process::id());
    docker_rm(&name);
    let started = std::process::Command::new("docker")
        .args([
            "run", "-d", "--name", &name, "alpine", "sh", "-c", "sleep 30",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !started {
        docker_rm(&name);
        return;
    }

    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 30".to_string(),
        options: Some(make_isolation_options(&name, "docker", "detached")),
        ..Default::default()
    });
    let alive = is_detached_session_alive(&record);
    let enriched = enrich_detached_status(&record);
    docker_rm(&name);

    assert_eq!(alive, Some(true));
    assert_eq!(enriched.status, ExecutionStatus::Executing);
    assert_eq!(enriched.exit_code, None);
}

/// A stopped detached container with no log footer must resolve to its real
/// exit code from `docker inspect`, never the `-1` sentinel.
#[test]
fn test_enrich_stopped_docker_container_uses_real_exit_code() {
    if !docker_available() {
        return;
    }
    let name = format!("issue136-stopped-{}", std::process::id());
    docker_rm(&name);
    let started = std::process::Command::new("docker")
        .args(["run", "--name", &name, "alpine", "sh", "-c", "exit 1"])
        .output()
        .map(|o| o.status.success() || o.status.code() == Some(1))
        .unwrap_or(false);
    if !started {
        docker_rm(&name);
        return;
    }

    // No log footer: force exit-code resolution through `docker inspect`.
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "exit 1".to_string(),
        log_path: Some("/nonexistent-issue136.log".to_string()),
        options: Some(make_isolation_options(&name, "docker", "detached")),
        ..Default::default()
    });
    let alive = is_detached_session_alive(&record);
    let enriched = enrich_detached_status(&record);
    docker_rm(&name);

    assert_eq!(alive, Some(false));
    assert_eq!(enriched.status, ExecutionStatus::Executed);
    assert_eq!(enriched.exit_code, Some(1));
    assert!(enriched.end_time.is_some());
}

#[test]
fn test_get_most_recent_session_name_match() {
    let (_temp_dir, store) = create_test_store();

    // Create two records with the same session name (e.g., reuse of session name)
    let mut record1 = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo first".to_string(),
        uuid: Some("older-uuid-101".to_string()),
        pid: Some(111),
        options: Some(make_isolation_options(
            "reused-session",
            "screen",
            "attached",
        )),
        ..Default::default()
    });
    record1.complete(0);
    store.save(&record1).unwrap();

    let record2 = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo second".to_string(),
        uuid: Some("newer-uuid-101".to_string()),
        pid: Some(222),
        options: Some(make_isolation_options(
            "reused-session",
            "screen",
            "detached",
        )),
        ..Default::default()
    });
    store.save(&record2).unwrap();

    // Should find the first matching record (order depends on storage)
    let found = store.get("reused-session");
    assert!(found.is_some());
    // Both records have this session name; get() returns the first match
    let found = found.unwrap();
    assert!(found.uuid == "older-uuid-101" || found.uuid == "newer-uuid-101");
}

// ===== Issue #105: attach_current_time for executing status =====

#[test]
fn test_attach_current_time_returns_some_for_executing_record() {
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        uuid: Some("issue-105-executing".to_string()),
        pid: Some(12345),
        status: Some(ExecutionStatus::Executing),
        log_path: Some("/tmp/test.log".to_string()),
        ..Default::default()
    });

    let before = chrono::Utc::now();
    let current_time = attach_current_time(&record);
    let after = chrono::Utc::now();

    assert!(current_time.is_some());
    let ct = current_time.unwrap();
    let parsed = chrono::DateTime::parse_from_rfc3339(&ct)
        .expect("currentTime must be a valid RFC3339 timestamp");
    assert!(parsed >= before - chrono::Duration::milliseconds(1));
    assert!(parsed <= after + chrono::Duration::milliseconds(1));
}

#[test]
fn test_attach_current_time_returns_none_for_executed_record() {
    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo hello".to_string(),
        uuid: Some("issue-105-executed".to_string()),
        pid: Some(12345),
        log_path: Some("/tmp/test.log".to_string()),
        ..Default::default()
    });
    record.complete(0);

    assert_eq!(record.status, ExecutionStatus::Executed);
    assert!(attach_current_time(&record).is_none());
}

#[test]
fn test_attach_current_time_does_not_mutate_record() {
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        uuid: Some("issue-105-no-mutation".to_string()),
        pid: Some(12345),
        status: Some(ExecutionStatus::Executing),
        log_path: Some("/tmp/test.log".to_string()),
        ..Default::default()
    });
    let snapshot = record.clone();
    let _ = attach_current_time(&record);
    assert_eq!(record.uuid, snapshot.uuid);
    assert_eq!(record.status, snapshot.status);
    assert_eq!(record.start_time, snapshot.start_time);
    assert_eq!(record.end_time, snapshot.end_time);
    assert_eq!(record.exit_code, snapshot.exit_code);
}

// ===== Issue #105: query_status surfaces currentTime via all formats =====

#[test]
fn test_query_status_json_includes_current_time_for_executing() {
    let (_temp_dir, store) = create_test_store();
    let before = chrono::Utc::now();

    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 100".to_string(),
        uuid: Some("issue-105-json-executing".to_string()),
        pid: Some(99999),
        status: Some(ExecutionStatus::Executing),
        log_path: Some("/tmp/executing.log".to_string()),
        ..Default::default()
    });
    store.save(&record).unwrap();

    let result = query_status(Some(&store), "issue-105-json-executing", Some("json"));
    assert!(result.success);
    let output = result.output.unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();

    let ct = parsed["currentTime"]
        .as_str()
        .expect("currentTime should be present and a string");
    let parsed_ct = chrono::DateTime::parse_from_rfc3339(ct)
        .expect("currentTime must be a valid RFC3339 timestamp");
    let after = chrono::Utc::now();
    assert!(parsed_ct >= before - chrono::Duration::seconds(1));
    assert!(parsed_ct <= after + chrono::Duration::seconds(1));
}

#[test]
fn test_query_status_json_omits_current_time_for_executed() {
    let (_temp_dir, store) = create_test_store();

    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo done".to_string(),
        uuid: Some("issue-105-json-executed".to_string()),
        pid: Some(11111),
        log_path: Some("/tmp/done.log".to_string()),
        ..Default::default()
    });
    record.complete(0);
    store.save(&record).unwrap();

    let result = query_status(Some(&store), "issue-105-json-executed", Some("json"));
    assert!(result.success);
    let output = result.output.unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();

    assert_eq!(parsed["status"], "executed");
    assert!(
        parsed.get("currentTime").is_none() || parsed["currentTime"].is_null(),
        "currentTime must not be present on completed records, got: {}",
        output
    );
}

#[test]
fn test_query_status_links_notation_includes_current_time_for_executing() {
    let (_temp_dir, store) = create_test_store();

    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 100".to_string(),
        uuid: Some("issue-105-links-executing".to_string()),
        pid: Some(99999),
        status: Some(ExecutionStatus::Executing),
        log_path: Some("/tmp/executing.log".to_string()),
        ..Default::default()
    });
    store.save(&record).unwrap();

    let result = query_status(Some(&store), "issue-105-links-executing", None);
    assert!(result.success);
    let output = result.output.unwrap();

    assert!(output.contains("status executing"));
    // currentTime should appear as an indented property with an ISO-like timestamp value
    let re = regex::Regex::new(r"\n  currentTime .*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}").unwrap();
    assert!(
        re.is_match(&output),
        "currentTime missing or unrecognized in links-notation output: {}",
        output
    );
}

#[test]
fn test_query_status_text_includes_current_time_for_executing() {
    let (_temp_dir, store) = create_test_store();

    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 100".to_string(),
        uuid: Some("issue-105-text-executing".to_string()),
        pid: Some(99999),
        status: Some(ExecutionStatus::Executing),
        log_path: Some("/tmp/executing.log".to_string()),
        ..Default::default()
    });
    store.save(&record).unwrap();

    let result = query_status(Some(&store), "issue-105-text-executing", Some("text"));
    assert!(result.success);
    let output = result.output.unwrap();

    assert!(output.contains("Status:"));
    assert!(output.contains("executing"));
    assert!(output.contains("Current Time:"));
    // Current Time should appear right after Start Time
    let start_idx = output.find("Start Time:").expect("Start Time line");
    let current_idx = output.find("Current Time:").expect("Current Time line");
    assert!(current_idx > start_idx);
}

#[test]
fn test_query_status_text_omits_current_time_for_executed() {
    let (_temp_dir, store) = create_test_store();

    let mut record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo done".to_string(),
        uuid: Some("issue-105-text-executed".to_string()),
        pid: Some(11111),
        log_path: Some("/tmp/done.log".to_string()),
        ..Default::default()
    });
    record.complete(0);
    store.save(&record).unwrap();

    let result = query_status(Some(&store), "issue-105-text-executed", Some("text"));
    assert!(result.success);
    let output = result.output.unwrap();

    assert!(!output.contains("Current Time:"));
}
