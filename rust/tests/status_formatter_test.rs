//! Tests for status_formatter module
//!
//! Tests for execution record formatting in various output formats.

use start_command::{
    format_record, format_record_as_links_notation, format_record_as_text, query_status,
    ExecutionRecord, ExecutionRecordOptions, ExecutionStatus, ExecutionStore,
    ExecutionStoreOptions,
};
use tempfile::TempDir;

fn create_test_record() -> ExecutionRecord {
    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo hello".to_string(),
        uuid: Some("test-uuid-1234".to_string()),
        pid: Some(12345),
        status: Some(ExecutionStatus::Executed),
        exit_code: Some(0),
        log_path: Some("/tmp/test.log".to_string()),
        start_time: Some("2025-01-01T00:00:00Z".to_string()),
        end_time: Some("2025-01-01T00:00:01Z".to_string()),
        working_directory: Some("/home/user".to_string()),
        shell: Some("/bin/bash".to_string()),
        platform: Some("linux".to_string()),
        ..Default::default()
    })
}

#[test]
fn test_format_record_as_links_notation() {
    let record = create_test_record();
    let output = format_record_as_links_notation(&record);

    // Should start with the UUID on its own line
    assert!(output.starts_with("test-uuid-1234\n"));
    // Should contain indented properties (values may or may not be quoted based on content)
    assert!(output.contains("  uuid test-uuid-1234"));
    assert!(output.contains("  status executed"));
    // command with space should be quoted
    assert!(output.contains("  command \"echo hello\""));
}

#[test]
fn test_format_record_as_text() {
    let record = create_test_record();
    let output = format_record_as_text(&record);

    assert!(output.contains("Execution Status"));
    assert!(output.contains("UUID:              test-uuid-1234"));
    assert!(output.contains("Status:            executed"));
    assert!(output.contains("Command:           echo hello"));
    assert!(output.contains("Exit Code:         0"));
    assert!(output.contains("PID:               12345"));
}

#[test]
fn test_format_record_as_json() {
    let record = create_test_record();
    let output = format_record(&record, "json").unwrap();

    // Parse the JSON to verify it's valid
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["uuid"], "test-uuid-1234");
    assert_eq!(parsed["command"], "echo hello");
    assert_eq!(parsed["status"], "executed");
}

#[test]
fn test_format_record_invalid_format() {
    let record = create_test_record();
    let result = format_record(&record, "invalid");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Unknown output format"));
}

#[test]
fn test_query_status_no_store() {
    let result = query_status(None, "some-uuid", None);
    assert!(!result.success);
    assert!(result.error.unwrap().contains("tracking is disabled"));
}

#[test]
fn test_query_status_not_found() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });

    let result = query_status(Some(&store), "nonexistent-uuid", None);
    assert!(!result.success);
    assert!(result.error.unwrap().contains("No execution found"));
}

#[test]
fn test_query_status_success() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });

    let record = create_test_record();
    store.save(&record).unwrap();

    let result = query_status(Some(&store), "test-uuid-1234", Some("json"));
    assert!(result.success);
    assert!(result.output.is_some());

    let output = result.output.unwrap();
    assert!(output.contains("test-uuid-1234"));
}

#[test]
fn test_query_status_default_format() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });

    let record = create_test_record();
    store.save(&record).unwrap();

    // Default format should be links-notation (indented style)
    let result = query_status(Some(&store), "test-uuid-1234", None);
    assert!(result.success);
    let output = result.output.unwrap();

    // Should be in links-notation indented format
    assert!(output.starts_with("test-uuid-1234\n"));
    // UUID without special chars is not quoted
    assert!(output.contains("  uuid test-uuid-1234"));
}
