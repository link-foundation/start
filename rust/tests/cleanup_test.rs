//! Tests for cleanup_stale and lock functionality in ExecutionStore

use start_command::execution_store::{
    CleanupOptions, ExecutionRecord, ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
};
use tempfile::TempDir;

/// Create a test store with temporary directory
fn create_test_store() -> (ExecutionStore, TempDir) {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        verbose: false,
        ..ExecutionStoreOptions::default()
    });
    (store, temp_dir)
}

#[test]
fn test_cleanup_stale_no_stale_records() {
    let (store, _temp) = create_test_store();

    // Create a record that just started (not stale)
    let record = ExecutionRecord::new("echo hello");
    store.save(&record).unwrap();

    let result = store.cleanup_stale(CleanupOptions {
        dry_run: false,
        ..Default::default()
    });

    assert_eq!(result.cleaned, 0);
    assert_eq!(result.records.len(), 0);
    assert!(result.errors.is_empty());
}

#[test]
fn test_cleanup_stale_dry_run() {
    let (store, _temp) = create_test_store();

    // Create a record with an old start time
    let mut record = ExecutionRecord::new("echo old");
    // Set start time to 25 hours ago
    let old_time = chrono::Utc::now() - chrono::Duration::hours(25);
    record.start_time = old_time.to_rfc3339();
    store.save(&record).unwrap();

    // Dry run should find the stale record but not clean it
    let result = store.cleanup_stale(CleanupOptions {
        dry_run: true,
        ..Default::default()
    });

    assert_eq!(result.cleaned, 1);
    assert_eq!(result.records.len(), 1);
    assert_eq!(result.records[0].uuid, record.uuid);

    // Record should still be executing
    let retrieved = store.get(&record.uuid).unwrap();
    assert_eq!(retrieved.status, ExecutionStatus::Executing);
}

#[test]
fn test_cleanup_stale_actual_cleanup() {
    let (store, _temp) = create_test_store();

    // Create a record with an old start time
    let mut record = ExecutionRecord::new("echo old");
    // Set start time to 25 hours ago
    let old_time = chrono::Utc::now() - chrono::Duration::hours(25);
    record.start_time = old_time.to_rfc3339();
    store.save(&record).unwrap();

    // Actual cleanup should mark the record as executed with exit code -1
    let result = store.cleanup_stale(CleanupOptions {
        dry_run: false,
        ..Default::default()
    });

    assert_eq!(result.cleaned, 1);
    assert_eq!(result.records.len(), 1);

    // Record should now be executed with exit code -1
    let retrieved = store.get(&record.uuid).unwrap();
    assert_eq!(retrieved.status, ExecutionStatus::Executed);
    assert_eq!(retrieved.exit_code, Some(-1));
    assert!(retrieved.end_time.is_some());
}

#[test]
fn test_cleanup_stale_custom_max_age() {
    let (store, _temp) = create_test_store();

    // Create a record with a 2 hour old start time
    let mut record = ExecutionRecord::new("echo recent");
    let old_time = chrono::Utc::now() - chrono::Duration::hours(2);
    record.start_time = old_time.to_rfc3339();
    store.save(&record).unwrap();

    // With default 24 hour max age, should not be stale
    let result = store.cleanup_stale(CleanupOptions {
        dry_run: true,
        ..Default::default()
    });
    assert_eq!(result.cleaned, 0);

    // With 1 hour max age, should be stale
    let result = store.cleanup_stale(CleanupOptions {
        dry_run: true,
        max_age_ms: Some(60 * 60 * 1000), // 1 hour
    });
    assert_eq!(result.cleaned, 1);
}

#[test]
fn test_cleanup_stale_only_executing_records() {
    let (store, _temp) = create_test_store();

    // Create an old executed record
    let mut executed_record = ExecutionRecord::new("echo done");
    let old_time = chrono::Utc::now() - chrono::Duration::hours(25);
    executed_record.start_time = old_time.to_rfc3339();
    executed_record.complete(0);
    store.save(&executed_record).unwrap();

    // Create an old executing record
    let mut executing_record = ExecutionRecord::new("echo running");
    executing_record.start_time = old_time.to_rfc3339();
    store.save(&executing_record).unwrap();

    let result = store.cleanup_stale(CleanupOptions {
        dry_run: true,
        ..Default::default()
    });

    // Only the executing record should be found as stale
    assert_eq!(result.cleaned, 1);
    assert_eq!(result.records[0].uuid, executing_record.uuid);
}
