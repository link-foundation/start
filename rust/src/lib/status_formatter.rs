//! Status formatter module for execution records
//!
//! Provides formatting functions for execution status output in various formats:
//! - Links Notation (links-notation): Structured link doublet format with nested options
//! - JSON: Standard JSON output
//! - Text: Human-readable text format

use crate::execution_store::{ExecutionRecord, ExecutionStore};
use crate::output_blocks::{escape_for_links_notation, format_value_for_links_notation};
use serde_json::Value;

/// Format execution record as Links Notation (indented style)
/// Uses nested Links notation for object values (like options) instead of JSON
///
/// Output format:
/// ```text
/// <uuid>
///   <key> <value>
///   options
///     <nested_key> <nested_value>
///   ...
/// ```
pub fn format_record_as_links_notation(record: &ExecutionRecord) -> String {
    let json = record.to_json();
    let mut lines = vec![record.uuid.clone()];

    if let Value::Object(map) = json {
        for (key, value) in map {
            if !value.is_null() {
                if key == "options" {
                    // Format options as nested Links notation
                    if let Value::Object(opts) = &value {
                        if !opts.is_empty() {
                            lines.push("  options".to_string());
                            for (opt_key, opt_value) in opts {
                                if !opt_value.is_null() {
                                    let formatted = format_value_for_links_notation(opt_value);
                                    lines.push(format!("    {} {}", opt_key, formatted));
                                }
                            }
                        }
                    }
                } else {
                    let formatted_value = match &value {
                        Value::String(s) => escape_for_links_notation(s),
                        Value::Bool(b) => b.to_string(),
                        Value::Number(n) => n.to_string(),
                        Value::Null => "null".to_string(),
                        Value::Object(_) | Value::Array(_) => {
                            // For other complex types, use nested format
                            format_value_for_links_notation(&value)
                        }
                    };
                    lines.push(format!("  {} {}", key, formatted_value));
                }
            }
        }
    }

    lines.join("\n")
}

/// Format execution record as human-readable text
pub fn format_record_as_text(record: &ExecutionRecord) -> String {
    let exit_code_str = record
        .exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "N/A".to_string());
    let pid_str = record
        .pid
        .map(|p| p.to_string())
        .unwrap_or_else(|| "N/A".to_string());
    let end_time_str = record.end_time.as_deref().unwrap_or("N/A");

    let mut lines = vec![
        "Execution Status".to_string(),
        "=".repeat(50),
        format!("UUID:              {}", record.uuid),
        format!("Status:            {}", record.status),
        format!("Command:           {}", record.command),
        format!("Exit Code:         {}", exit_code_str),
        format!("PID:               {}", pid_str),
        format!("Working Directory: {}", record.working_directory),
        format!("Shell:             {}", record.shell),
        format!("Platform:          {}", record.platform),
        format!("Start Time:        {}", record.start_time),
        format!("End Time:          {}", end_time_str),
        format!("Log Path:          {}", record.log_path),
    ];

    // Format options as nested list instead of JSON
    if !record.options.is_empty() {
        lines.push("Options:".to_string());
        for (key, value) in &record.options {
            let value_str = match value {
                Value::String(s) => s.clone(),
                Value::Bool(b) => b.to_string(),
                Value::Number(n) => n.to_string(),
                Value::Null => "null".to_string(),
                other => serde_json::to_string(other).unwrap_or_default(),
            };
            lines.push(format!("  {}: {}", key, value_str));
        }
    }

    lines.join("\n")
}

/// Format execution record based on format type
pub fn format_record(record: &ExecutionRecord, format: &str) -> Result<String, String> {
    match format {
        "links-notation" => Ok(format_record_as_links_notation(record)),
        "json" => serde_json::to_string_pretty(&record.to_json())
            .map_err(|e| format!("Failed to serialize to JSON: {}", e)),
        "text" => Ok(format_record_as_text(record)),
        _ => Err(format!("Unknown output format: {}", format)),
    }
}

/// Query result from status lookup
pub struct StatusQueryResult {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}

/// Handle status query and return the result
pub fn query_status(
    store: Option<&ExecutionStore>,
    uuid: &str,
    output_format: Option<&str>,
) -> StatusQueryResult {
    let store = match store {
        Some(s) => s,
        None => {
            return StatusQueryResult {
                success: false,
                output: None,
                error: Some("Execution tracking is disabled.".to_string()),
            }
        }
    };

    let record = match store.get(uuid) {
        Some(r) => r,
        None => {
            return StatusQueryResult {
                success: false,
                output: None,
                error: Some(format!("No execution found with UUID: {}", uuid)),
            }
        }
    };

    let format = output_format.unwrap_or("links-notation");
    match format_record(&record, format) {
        Ok(output) => StatusQueryResult {
            success: true,
            output: Some(output),
            error: None,
        },
        Err(e) => StatusQueryResult {
            success: false,
            output: None,
            error: Some(e),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution_store::{ExecutionRecordOptions, ExecutionStatus};
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
        use crate::execution_store::ExecutionStoreOptions;

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
        use crate::execution_store::ExecutionStoreOptions;

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
        use crate::execution_store::ExecutionStoreOptions;

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
}
