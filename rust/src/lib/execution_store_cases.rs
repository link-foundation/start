//! Tests for the execution tracking store.

use super::*;
use tempfile::TempDir;

fn create_test_store() -> (ExecutionStore, TempDir) {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false), // Disable links for unit tests
        verbose: false,
    });
    (store, temp_dir)
}

#[test]
fn test_execution_record_new() {
    let record = ExecutionRecord::new("echo hello");
    assert!(!record.uuid.is_empty());
    assert_eq!(record.command, "echo hello");
    assert_eq!(record.status, ExecutionStatus::Executing);
    assert!(record.exit_code.is_none());
    assert!(record.end_time.is_none());
}

#[test]
fn test_execution_record_complete() {
    let mut record = ExecutionRecord::new("echo hello");
    assert_eq!(record.status, ExecutionStatus::Executing);
    assert!(record.exit_code.is_none());

    record.complete(0);

    assert_eq!(record.status, ExecutionStatus::Executed);
    assert_eq!(record.exit_code, Some(0));
    assert!(record.end_time.is_some());
}

#[test]
fn test_execution_record_json_roundtrip() {
    let mut record = ExecutionRecord::new("echo hello");
    record.pid = Some(12345);
    record.log_path = "/tmp/test.log".to_string();

    let json = record.to_json();
    let restored = ExecutionRecord::from_json(&json).unwrap();

    assert_eq!(restored.uuid, record.uuid);
    assert_eq!(restored.command, "echo hello");
    assert_eq!(restored.pid, Some(12345));
}

#[test]
fn test_store_save_and_get() {
    let (store, _temp) = create_test_store();
    let mut record = ExecutionRecord::new("echo hello");
    record.pid = Some(12345);
    store.save(&record).unwrap();
    let retrieved = store.get(&record.uuid).unwrap();
    assert_eq!(
        (retrieved.uuid, retrieved.command.as_str(), retrieved.pid),
        (record.uuid, "echo hello", Some(12345))
    );
}

#[test]
fn test_store_update() {
    let (store, _temp) = create_test_store();
    let mut record = ExecutionRecord::new("echo hello");
    store.save(&record).unwrap();
    record.complete(0);
    store.save(&record).unwrap();
    let r = store.get(&record.uuid).unwrap();
    assert_eq!(
        (r.status, r.exit_code),
        (ExecutionStatus::Executed, Some(0))
    );
}

#[test]
fn test_store_get_all() {
    let (store, _temp) = create_test_store();
    for i in 1..=3 {
        store
            .save(&ExecutionRecord::new(&format!("e{}", i)))
            .unwrap();
    }
    assert_eq!(store.get_all().len(), 3);
}

#[test]
fn test_store_get_by_status() {
    let (store, _temp) = create_test_store();
    store.save(&ExecutionRecord::new("1")).unwrap();
    store.save(&ExecutionRecord::new("2")).unwrap();
    let mut done = ExecutionRecord::new("3");
    done.complete(0);
    store.save(&done).unwrap();
    assert_eq!(
        (
            store.get_executing().len(),
            store.get_by_status(ExecutionStatus::Executed).len()
        ),
        (2, 1)
    );
}

#[test]
fn test_store_delete() {
    let (store, _temp) = create_test_store();
    let record = ExecutionRecord::new("echo hello");
    store.save(&record).unwrap();
    assert!(store.get(&record.uuid).is_some() && store.delete(&record.uuid).unwrap());
    assert!(store.get(&record.uuid).is_none());
}

#[test]
fn test_store_clear() {
    let (store, _temp) = create_test_store();
    store.save(&ExecutionRecord::new("1")).unwrap();
    store.save(&ExecutionRecord::new("2")).unwrap();
    assert_eq!(store.get_all().len(), 2);
    store.clear().unwrap();
    assert_eq!(store.get_all().len(), 0);
}

#[test]
fn test_store_get_stats() {
    let (store, _temp) = create_test_store();
    store.save(&ExecutionRecord::new("1")).unwrap();
    let mut ok = ExecutionRecord::new("2");
    ok.complete(0);
    store.save(&ok).unwrap();
    let mut fail = ExecutionRecord::new("3");
    fail.complete(1);
    store.save(&fail).unwrap();
    let s = store.get_stats();
    assert_eq!(
        (s.total, s.executing, s.executed, s.successful, s.failed),
        (3, 1, 2, 1, 1)
    );
}
// Note: Additional tests in tests/cleanup.rs
