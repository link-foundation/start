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
