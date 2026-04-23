//! Status formatter module for execution records
//!
//! Provides formatting functions for execution status output in various formats:
//! - Links Notation (links-notation): Structured link doublet format with nested options
//! - JSON: Standard JSON output
//! - Text: Human-readable text format

use crate::execution_store::{ExecutionRecord, ExecutionStatus, ExecutionStore};
use crate::output_blocks::{escape_for_links_notation, format_value_for_links_notation};
use serde_json::Value;
use std::fs;
use std::process::Command;

/// Check if a detached isolation session is still running
/// Returns Some(true) if running, Some(false) if not, None if unable to determine
pub fn is_detached_session_alive(record: &ExecutionRecord) -> Option<bool> {
    let session_name = record.options.get("sessionName")?.as_str()?;
    let isolation_mode = record.options.get("isolationMode")?.as_str()?;
    let isolated = record.options.get("isolated")?.as_str()?;

    if isolation_mode != "detached" {
        return None;
    }

    match isolated {
        "screen" => {
            let output = Command::new("screen").args(["-ls"]).output().ok()?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            Some(stdout.contains(session_name))
        }
        "tmux" => {
            let status = Command::new("tmux")
                .args(["has-session", "-t", session_name])
                .output()
                .ok()?;
            Some(status.status.success())
        }
        "docker" => {
            let output = Command::new("docker")
                .args(["inspect", "-f", "{{.State.Running}}", session_name])
                .output()
                .ok()?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            Some(stdout.trim() == "true")
        }
        "ssh" => {
            // For SSH, check if the local wrapper PID is still running
            #[cfg(unix)]
            {
                if let Some(pid) = record.pid {
                    let result = unsafe { libc::kill(pid as i32, 0) };
                    Some(result == 0)
                } else {
                    None
                }
            }
            #[cfg(not(unix))]
            {
                let _ = record.pid;
                None
            }
        }
        _ => None,
    }
}

fn read_exit_code_from_log(log_path: &str) -> Option<i32> {
    let content = fs::read_to_string(log_path).ok()?;
    content
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("Exit Code:"))
        .and_then(|value| value.trim().parse::<i32>().ok())
}

/// Enrich execution record with live session status for detached executions.
/// If a record shows "executing" but the detached session has actually ended,
/// returns an updated copy with status "executed". If it shows "executed" but
/// the session is still running, returns a copy with status "executing".
pub fn enrich_detached_status(record: &ExecutionRecord) -> ExecutionRecord {
    let alive = match is_detached_session_alive(record) {
        Some(v) => v,
        None => return record.clone(),
    };

    let mut enriched = record.clone();

    if alive && enriched.status == ExecutionStatus::Executed {
        // Session still running but record says executed - correct it
        enriched.status = ExecutionStatus::Executing;
        enriched.exit_code = None;
        enriched.end_time = None;
    } else if !alive && enriched.status == ExecutionStatus::Executing {
        // Session ended but record says executing - correct it
        enriched.status = ExecutionStatus::Executed;
        if enriched.exit_code.is_none() {
            enriched.exit_code = Some(read_exit_code_from_log(&enriched.log_path).unwrap_or(-1));
        }
        if enriched.end_time.is_none() {
            enriched.end_time = Some(chrono::Utc::now().to_rfc3339());
        }
    }

    enriched
}

/// Compute a `currentTime` value for a record if its status is `executing`.
/// Returns `None` for completed records. Wrapping this in a helper makes it
/// easy to attach the same timestamp to all output formats and to test the
/// behavior deterministically.
pub fn attach_current_time(record: &ExecutionRecord) -> Option<String> {
    if record.status == ExecutionStatus::Executing {
        Some(chrono::Utc::now().to_rfc3339())
    } else {
        None
    }
}

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
    format_record_as_links_notation_with_current_time(record, None)
}

/// Same as [`format_record_as_links_notation`] but injects a `currentTime`
/// field (right after `startTime`) when a value is supplied.
pub fn format_record_as_links_notation_with_current_time(
    record: &ExecutionRecord,
    current_time: Option<&str>,
) -> String {
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

            // Insert currentTime right after startTime for readability
            if key == "startTime" {
                if let Some(ct) = current_time {
                    lines.push(format!("  currentTime {}", escape_for_links_notation(ct)));
                }
            }
        }
    }

    lines.join("\n")
}

/// Format execution record as human-readable text
pub fn format_record_as_text(record: &ExecutionRecord) -> String {
    format_record_as_text_with_current_time(record, None)
}

/// Same as [`format_record_as_text`] but adds a `Current Time:` line right
/// after `Start Time:` when a value is supplied.
pub fn format_record_as_text_with_current_time(
    record: &ExecutionRecord,
    current_time: Option<&str>,
) -> String {
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
    ];
    if let Some(ct) = current_time {
        lines.push(format!("Current Time:      {}", ct));
    }
    lines.push(format!("End Time:          {}", end_time_str));
    lines.push(format!("Log Path:          {}", record.log_path));

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

/// Build the JSON value for a record, optionally including `currentTime`.
fn record_json_with_current_time(record: &ExecutionRecord, current_time: Option<&str>) -> Value {
    let mut json = record.to_json();
    if let (Some(ct), Value::Object(map)) = (current_time, &mut json) {
        map.insert("currentTime".to_string(), Value::String(ct.to_string()));
    }
    json
}

/// Format execution record based on format type
pub fn format_record(record: &ExecutionRecord, format: &str) -> Result<String, String> {
    format_record_with_current_time(record, format, None)
}

/// Same as [`format_record`] but the output includes `currentTime` when a
/// value is supplied. Use this from [`query_status`] so all three formats
/// stay in sync.
pub fn format_record_with_current_time(
    record: &ExecutionRecord,
    format: &str,
    current_time: Option<&str>,
) -> Result<String, String> {
    match format {
        "links-notation" => Ok(format_record_as_links_notation_with_current_time(
            record,
            current_time,
        )),
        "json" => {
            serde_json::to_string_pretty(&record_json_with_current_time(record, current_time))
                .map_err(|e| format!("Failed to serialize to JSON: {}", e))
        }
        "text" => Ok(format_record_as_text_with_current_time(
            record,
            current_time,
        )),
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
    identifier: &str,
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

    let record = match store.get(identifier) {
        Some(r) => r,
        None => {
            return StatusQueryResult {
                success: false,
                output: None,
                error: Some(format!(
                    "No execution found with UUID or session name: {}",
                    identifier
                )),
            }
        }
    };

    // Enrich detached execution status with live session check
    let enriched = enrich_detached_status(&record);
    // Attach currentTime so callers can see how long an executing command has been running
    let current_time = attach_current_time(&enriched);

    let format = output_format.unwrap_or("links-notation");
    match format_record_with_current_time(&enriched, format, current_time.as_deref()) {
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
