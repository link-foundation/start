//! Integration tests for start-command.
//!
//! These tests verify the public API works correctly.

use start_command::{parse_args, validate_options, VALID_BACKENDS};

fn to_string_vec(strs: &[&str]) -> Vec<String> {
    strs.iter().map(|s| s.to_string()).collect()
}

mod args_parser_integration_tests {
    use super::*;

    #[test]
    fn test_parse_simple_command_integration() {
        let args = to_string_vec(&["echo", "hello"]);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.raw_command, vec!["echo", "hello"]);
        assert_eq!(parsed.command, "echo hello");
    }

    #[test]
    fn test_parse_isolated_mode_integration() {
        let args = to_string_vec(&["--isolated", "screen", "--", "echo", "test"]);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.wrapper_options.isolated.as_deref(), Some("screen"));
    }

    #[test]
    fn test_validate_options_valid_backends() {
        for backend in VALID_BACKENDS.iter() {
            // Docker requires --image, SSH requires --endpoint
            if *backend == "docker" || *backend == "ssh" {
                continue;
            }
            let args = to_string_vec(&["--isolated", *backend, "--", "echo", "test"]);
            let parsed = parse_args(&args).unwrap();
            let result = validate_options(&parsed.wrapper_options);
            assert!(result.is_ok(), "Backend '{}' should be valid", backend);
        }
    }

    #[test]
    fn test_parse_with_separator() {
        let args = to_string_vec(&["--attached", "--", "echo", "hello world"]);
        let parsed = parse_args(&args).unwrap();
        assert!(parsed.wrapper_options.attached);
        assert_eq!(parsed.raw_command, vec!["echo", "hello world"]);
    }

    #[test]
    fn test_parse_detached_mode() {
        let args = to_string_vec(&["--detached", "--", "echo", "background"]);
        let parsed = parse_args(&args).unwrap();
        assert!(parsed.wrapper_options.detached);
    }

    #[test]
    fn test_parse_with_session_name() {
        // --session requires --isolated
        let args = to_string_vec(&[
            "--isolated",
            "screen",
            "--session",
            "mysession",
            "--",
            "echo",
            "test",
        ]);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.wrapper_options.session.as_deref(), Some("mysession"));
    }

    #[test]
    fn test_docker_with_image() {
        let args = to_string_vec(&[
            "--isolated",
            "docker",
            "--image",
            "node:20",
            "--",
            "npm",
            "test",
        ]);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.wrapper_options.isolated.as_deref(), Some("docker"));
        assert_eq!(parsed.wrapper_options.image.as_deref(), Some("node:20"));
    }
}

mod version_tests {
    #[test]
    fn test_cargo_version_format() {
        // Verify Cargo.toml version is accessible and valid
        let version = env!("CARGO_PKG_VERSION");
        assert!(!version.is_empty());
        assert!(
            version.starts_with("0."),
            "Version should follow semver format: {}",
            version
        );
    }

    #[test]
    fn test_package_name() {
        let name = env!("CARGO_PKG_NAME");
        assert_eq!(name, "start-command");
    }

    #[test]
    fn test_package_has_description() {
        let description = env!("CARGO_PKG_DESCRIPTION");
        assert!(!description.is_empty());
    }
}

/// Tests for public exports of start_command library
/// Verifies that ExecutionStore and related types are properly exported
mod public_exports_tests {
    use start_command::{
        is_clink_installed, ExecutionRecord, ExecutionRecordOptions, ExecutionStatus,
        ExecutionStore, ExecutionStoreOptions,
    };
    use tempfile::TempDir;

    #[test]
    fn test_execution_store_export() {
        // Verify ExecutionStore is exported and can be instantiated
        let temp_dir = TempDir::new().unwrap();
        let store = ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(temp_dir.path().to_path_buf()),
            use_links: Some(false),
            verbose: false,
        });
        assert!(store.app_folder().exists());
    }

    #[test]
    fn test_execution_record_export() {
        // Verify ExecutionRecord is exported and can be created
        let record = ExecutionRecord::new("echo test");
        assert!(!record.uuid.is_empty());
        assert_eq!(record.command, "echo test");
        assert_eq!(record.status, ExecutionStatus::Executing);
    }

    #[test]
    fn test_execution_record_options_export() {
        // Verify ExecutionRecordOptions is exported
        let options = ExecutionRecordOptions {
            uuid: Some("custom-uuid".to_string()),
            pid: Some(12345),
            log_path: Some("/tmp/test.log".to_string()),
            ..ExecutionRecordOptions::default()
        };
        let record = ExecutionRecord::with_options("echo test", options);
        assert_eq!(record.uuid, "custom-uuid");
        assert_eq!(record.pid, Some(12345));
    }

    #[test]
    fn test_execution_status_export() {
        // Verify ExecutionStatus enum is exported
        assert_eq!(ExecutionStatus::Executing.as_str(), "executing");
        assert_eq!(ExecutionStatus::Executed.as_str(), "executed");
    }

    #[test]
    fn test_execution_store_options_export() {
        // Verify ExecutionStoreOptions is exported and can be used
        let options = ExecutionStoreOptions {
            app_folder: None,
            use_links: Some(false),
            verbose: true,
        };
        assert!(options.app_folder.is_none());
        assert_eq!(options.use_links, Some(false));
        assert!(options.verbose);
    }

    #[test]
    fn test_is_clink_installed_export() {
        // Verify is_clink_installed is exported and callable
        let result = is_clink_installed();
        // Just verify it returns a boolean without crashing
        assert!(result || !result);
    }

    #[test]
    fn test_full_workflow() {
        // Test the complete workflow as a library user would
        let temp_dir = TempDir::new().unwrap();

        // Create store
        let store = ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(temp_dir.path().to_path_buf()),
            use_links: Some(false),
            verbose: false,
        });

        // Create and save record
        let mut record = ExecutionRecord::new("echo 'hello world'");
        record.pid = Some(std::process::id());
        record.log_path = "/tmp/test.log".to_string();

        store.save(&record).expect("Failed to save record");

        // Retrieve record
        let retrieved = store.get(&record.uuid);
        assert!(retrieved.is_some());
        let retrieved = retrieved.unwrap();
        assert_eq!(retrieved.command, "echo 'hello world'");
        assert_eq!(retrieved.status, ExecutionStatus::Executing);

        // Complete record
        let mut updated_record = record.clone();
        updated_record.complete(0);
        store.save(&updated_record).expect("Failed to update record");

        // Verify completion
        let completed = store.get(&updated_record.uuid);
        assert!(completed.is_some());
        let completed = completed.unwrap();
        assert_eq!(completed.status, ExecutionStatus::Executed);
        assert_eq!(completed.exit_code, Some(0));
        assert!(completed.end_time.is_some());

        // Test stats
        let stats = store.get_stats();
        assert_eq!(stats.total, 1);
        assert_eq!(stats.executed, 1);
        assert_eq!(stats.successful, 1);
    }

    #[test]
    fn test_execution_stats_export() {
        // Verify ExecutionStats struct fields are accessible
        let temp_dir = TempDir::new().unwrap();
        let store = ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(temp_dir.path().to_path_buf()),
            use_links: Some(false),
            verbose: false,
        });
        let stats = store.get_stats();

        // Verify all stats fields are accessible
        assert_eq!(stats.total, 0);
        assert_eq!(stats.executing, 0);
        assert_eq!(stats.executed, 0);
        assert_eq!(stats.successful, 0);
        assert_eq!(stats.failed, 0);
        assert!(!stats.clink_available); // Because we set use_links to false
        assert!(!stats.lino_db_path.is_empty());
        assert!(!stats.links_db_path.is_empty());
    }
}
