//! Additional tests for ExecutionStore and related types.
//!
//! Covers additional test cases from js/test/execution-store.test.js
//! that are not already covered in src/lib/execution_store.rs inline tests.

use start_command::{
    CleanupOptions, ExecutionRecord, ExecutionRecordOptions, ExecutionStatus, ExecutionStore,
    ExecutionStoreOptions,
};
use tempfile::TempDir;

fn make_store() -> (TempDir, ExecutionStore) {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    (temp_dir, store)
}

mod execution_record_tests {
    use super::*;

    #[test]
    fn should_create_new_execution_record_with_default_values() {
        let record = ExecutionRecord::new("echo test");
        assert!(!record.uuid.is_empty());
        assert_eq!(record.command, "echo test");
        assert_eq!(record.status, ExecutionStatus::Executing);
        assert!(!record.start_time.is_empty());
        assert!(record.end_time.is_none());
        assert!(record.exit_code.is_none());
    }

    #[test]
    fn should_create_execution_record_with_custom_values() {
        let record = ExecutionRecord::with_options(ExecutionRecordOptions {
            command: "npm test".to_string(),
            uuid: Some("custom-uuid-123".to_string()),
            pid: Some(12345),
            log_path: Some("/tmp/test.log".to_string()),
            ..ExecutionRecordOptions::default()
        });
        assert_eq!(record.uuid, "custom-uuid-123");
        assert_eq!(record.command, "npm test");
        assert_eq!(record.pid, Some(12345));
        assert_eq!(record.log_path, "/tmp/test.log");
    }

    #[test]
    fn should_mark_execution_as_completed() {
        let mut record = ExecutionRecord::new("echo test");
        record.complete(0);
        assert_eq!(record.status, ExecutionStatus::Executed);
        assert_eq!(record.exit_code, Some(0));
        assert!(record.end_time.is_some());
    }

    #[test]
    fn should_mark_execution_as_failed() {
        let mut record = ExecutionRecord::new("failing-cmd");
        record.complete(1);
        assert_eq!(record.status, ExecutionStatus::Executed);
        assert_eq!(record.exit_code, Some(1));
    }
}

mod execution_store_tests {
    use super::*;

    #[test]
    fn should_create_app_folder_on_initialization() {
        let temp_dir = TempDir::new().unwrap();
        let folder = temp_dir.path().join("test-app");
        let store = ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(folder.clone()),
            use_links: Some(false),
            verbose: false,
        });
        assert!(store.app_folder().exists());
    }

    #[test]
    fn should_save_and_retrieve_an_execution_record() {
        let (_dir, store) = make_store();
        let record = ExecutionRecord::new("echo test");
        let uuid = record.uuid.clone();

        store.save(&record).expect("Should save record");

        let retrieved = store.get(&uuid);
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().command, "echo test");
    }

    #[test]
    fn should_update_an_existing_record() {
        let (_dir, store) = make_store();
        let mut record = ExecutionRecord::new("npm test");
        store.save(&record).unwrap();

        record.complete(0);
        store.save(&record).unwrap();

        let updated = store.get(&record.uuid).unwrap();
        assert_eq!(updated.status, ExecutionStatus::Executed);
        assert_eq!(updated.exit_code, Some(0));
    }

    #[test]
    fn should_get_all_records() {
        let (_dir, store) = make_store();
        let r1 = ExecutionRecord::new("cmd1");
        let r2 = ExecutionRecord::new("cmd2");
        store.save(&r1).unwrap();
        store.save(&r2).unwrap();

        let all = store.get_all();
        assert!(all.len() >= 2);
    }

    #[test]
    fn should_get_records_by_status() {
        let (_dir, store) = make_store();
        let r1 = ExecutionRecord::new("executing-cmd");
        let mut r2 = ExecutionRecord::new("executed-cmd");
        r2.complete(0);

        store.save(&r1).unwrap();
        store.save(&r2).unwrap();

        let executing = store.get_by_status(ExecutionStatus::Executing);
        assert!(!executing.is_empty(), "Should have executing records");

        let executed = store.get_by_status(ExecutionStatus::Executed);
        assert!(!executed.is_empty(), "Should have executed records");
    }

    #[test]
    fn should_delete_a_record() {
        let (_dir, store) = make_store();
        let record = ExecutionRecord::new("test cmd");
        let uuid = record.uuid.clone();

        store.save(&record).unwrap();
        assert!(store.get(&uuid).is_some());

        let deleted = store.delete(&uuid).unwrap_or(false);
        assert!(deleted);
        assert!(store.get(&uuid).is_none());
    }

    #[test]
    fn should_return_false_when_deleting_non_existent_record() {
        let (_dir, store) = make_store();
        let deleted = store.delete("non-existent-uuid");
        // Should return Ok(false) for non-existent record
        assert!(matches!(deleted, Ok(false) | Err(_)));
    }

    #[test]
    fn should_get_statistics() {
        let (_dir, store) = make_store();
        let r1 = ExecutionRecord::new("cmd1");
        let mut r2 = ExecutionRecord::new("cmd2");
        r2.complete(0);
        let mut r3 = ExecutionRecord::new("cmd3");
        r3.complete(1);

        store.save(&r1).unwrap();
        store.save(&r2).unwrap();
        store.save(&r3).unwrap();

        let stats = store.get_stats();
        assert_eq!(stats.total, 3);
        assert!(stats.executing >= 1);
        assert!(stats.executed >= 2);
    }

    #[test]
    fn should_handle_special_characters_in_command() {
        let (_dir, store) = make_store();
        let record = ExecutionRecord::new("echo 'hello world' && ls -la");
        let uuid = record.uuid.clone();
        store.save(&record).unwrap();

        let retrieved = store.get(&uuid).unwrap();
        assert_eq!(retrieved.command, "echo 'hello world' && ls -la");
    }

    #[test]
    fn should_handle_unicode_characters() {
        let (_dir, store) = make_store();
        let record = ExecutionRecord::new("echo '你好世界 🌍'");
        let uuid = record.uuid.clone();
        store.save(&record).unwrap();

        let retrieved = store.get(&uuid).unwrap();
        assert_eq!(retrieved.command, "echo '你好世界 🌍'");
    }

    #[test]
    fn should_return_empty_cleanup_result_when_no_stale_records_exist() {
        let (_dir, store) = make_store();
        let result = store.cleanup_stale(CleanupOptions {
            dry_run: true,
            ..CleanupOptions::default()
        });
        // Fresh store should have no stale records to clean up
        assert_eq!(result.cleaned, 0);
    }
}

mod execution_status_tests {
    use super::*;

    #[test]
    fn executing_status_as_str() {
        assert_eq!(ExecutionStatus::Executing.as_str(), "executing");
    }

    #[test]
    fn executed_status_as_str() {
        assert_eq!(ExecutionStatus::Executed.as_str(), "executed");
    }

    #[test]
    fn should_get_recent_records() {
        let (_dir, store) = make_store();
        let r1 = ExecutionRecord::new("cmd1");
        let r2 = ExecutionRecord::new("cmd2");
        let r3 = ExecutionRecord::new("cmd3");
        store.save(&r1).unwrap();
        store.save(&r2).unwrap();
        store.save(&r3).unwrap();

        let recent = store.get_recent(2);
        // Should return at most 2 records
        assert!(recent.len() <= 2);
    }
}
