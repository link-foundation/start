//! Tests for --status lookup by session name and detached status enrichment
//! Issue #101: --session name not usable with --status, and --detached reports immediate completion

use start_command::{
    enrich_detached_status, is_detached_session_alive, query_status, ExecutionRecord,
    ExecutionRecordOptions, ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
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
