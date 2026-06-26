//! Status formatter module for execution records
//!
//! Provides formatting functions for execution status output in various formats:
//! - Links Notation (links-notation): Structured link doublet format with nested options
//! - JSON: Standard JSON output
//! - Text: Human-readable text format

use crate::execution_control::collect_process_ids;
use crate::execution_store::{ExecutionRecord, ExecutionStatus, ExecutionStore};
use crate::output_blocks::{escape_for_links_notation, format_value_for_links_notation};
use serde_json::Value;
use std::fs;
use std::process::Command;

/// Live state of a detached docker container by name.
struct DockerState {
    running: bool,
    exit_code: Option<i32>,
    oom_killed: Option<bool>,
}

/// Inspect the live state of a detached docker container by name.
///
/// Distinguishes "running", "stopped (with a real exit code)", and "cannot be
/// inspected at all". The last case matters on slow Docker-in-Docker hosts
/// (issue #136): right after `docker run -d` returns, `docker inspect <name>`
/// can transiently fail because the container is not visible yet. A failed
/// inspect must NOT be read as "stopped"; it means "unknown", so callers can
/// keep the session running instead of fabricating a terminal `-1` result.
///
/// Returns None when the container cannot be inspected (not found yet, removed,
/// or docker error).
fn inspect_docker_state(session_name: &str) -> Option<DockerState> {
    let output = Command::new("docker")
        .args([
            "inspect",
            "-f",
            "{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}}",
            session_name,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.split_whitespace();
    let running = parts.next() == Some("true");
    let exit_code = parts.next().and_then(|value| value.parse::<i32>().ok());
    let oom_killed = parts.next().and_then(|value| match value {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    });
    Some(DockerState {
        running,
        exit_code,
        oom_killed,
    })
}

/// Best-effort terminal exit code reported by the isolation backend itself
/// (currently docker via `docker inspect .State.ExitCode`). Returns None when
/// the backend cannot provide a real code, so callers never surface the `-1`
/// sentinel for a session whose real exit code is simply not available yet.
fn read_backend_exit_code(record: &ExecutionRecord) -> Option<i32> {
    if record.options.get("isolated")?.as_str()? != "docker" {
        return None;
    }
    let session_name = record.options.get("sessionName")?.as_str()?;
    let state = inspect_docker_state(session_name)?;
    if state.running {
        None
    } else {
        state.exit_code
    }
}

fn read_docker_oom_killed(record: &ExecutionRecord) -> Option<bool> {
    if record.options.get("isolated")?.as_str()? != "docker" {
        return None;
    }
    let session_name = record.options.get("sessionName")?.as_str()?;
    inspect_docker_state(session_name)?.oom_killed
}

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
            // A failed inspect means the container is not visible yet (still
            // being created on a slow DinD host) or already removed — not
            // "stopped". Return None (unknown) so the session is not falsely
            // marked finished (issue #136).
            inspect_docker_state(session_name).map(|state| state.running)
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
    let footer_exit = read_exit_code_from_log(&record.log_path);

    let alive = match is_detached_session_alive(record) {
        Some(v) => v,
        None => {
            // Liveness is unknown: the backend could not be probed (e.g. a
            // detached docker container that is not visible yet on a slow
            // Docker-in-Docker host, or one that has already been removed).
            // Honor a terminal `Exit Code:` footer if the command wrote one;
            // otherwise leave the record untouched (still executing) rather than
            // fabricating a `-1` terminal result that orchestrators misread as a
            // finished/failed run (issue #136).
            let is_detached =
                record.options.get("isolationMode").and_then(|v| v.as_str()) == Some("detached");
            if is_detached && record.status == ExecutionStatus::Executing && footer_exit.is_some() {
                let mut enriched = record.clone();
                enriched.status = ExecutionStatus::Executed;
                enriched.exit_code = footer_exit;
                if enriched.end_time.is_none() {
                    enriched.end_time = Some(chrono::Utc::now().to_rfc3339());
                }
                return enriched;
            }
            return record.clone();
        }
    };

    let mut enriched = record.clone();
    if let Some(oom_killed) = read_docker_oom_killed(&enriched) {
        enriched.oom_killed = Some(oom_killed);
    }

    if alive && enriched.status == ExecutionStatus::Executed {
        // A live `screen -ls` (or `tmux`/`docker`) session does NOT mean the command
        // is still running: a lingering shell can outlive a killed command (e.g. the
        // OOM killer sends SIGKILL, exit 137, but the login shell stays up for a
        // window after `start` already wrote the terminal footer). The footer/recorded
        // exit code is authoritative. Only flip back to "executing" when there is NO
        // recorded terminal exit code AND no `Exit Code:` footer in the log.
        if enriched.exit_code.is_none() && footer_exit.is_none() {
            // Session still running and no terminal record - correct it
            enriched.status = ExecutionStatus::Executing;
            enriched.exit_code = None;
            enriched.end_time = None;
        }
        // Otherwise keep the recorded/footer exit code - the command has finished.
    } else if !alive && enriched.status == ExecutionStatus::Executing {
        // Session ended but record says executing - correct it. Resolve a real
        // exit code: prefer the log footer, then the backend's own record (e.g.
        // `docker inspect .State.ExitCode`), and only fall back to the `-1`
        // sentinel as a last resort when no real code can be obtained (issue #136).
        enriched.status = ExecutionStatus::Executed;
        if enriched.exit_code.is_none() {
            enriched.exit_code = Some(
                footer_exit
                    .or_else(|| read_backend_exit_code(&enriched))
                    .unwrap_or(-1),
            );
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
    format_record_as_links_notation_with_enrichments(record, current_time, None)
}

fn append_links_array(lines: &mut Vec<String>, values: &[Value], indent: usize) {
    let prefix = " ".repeat(indent);
    if values.is_empty() {
        lines.push(format!("{}()", prefix));
        return;
    }

    lines.push(format!("{}(", prefix));
    for value in values {
        match value {
            Value::Array(nested) => append_links_array(lines, nested, indent + 2),
            Value::Object(map) => {
                for (child_key, child_value) in map {
                    if !child_value.is_null() {
                        append_links_value(lines, child_key, child_value, indent + 2);
                    }
                }
            }
            _ => lines.push(format!(
                "{}{}",
                " ".repeat(indent + 2),
                format_value_for_links_notation(value)
            )),
        }
    }
    lines.push(format!("{})", prefix));
}

fn append_links_value(lines: &mut Vec<String>, key: &str, value: &Value, indent: usize) {
    let prefix = " ".repeat(indent);
    match value {
        Value::Object(map) => {
            if map.is_empty() {
                return;
            }
            lines.push(format!("{}{}", prefix, key));
            for (child_key, child_value) in map {
                if !child_value.is_null() {
                    append_links_value(lines, child_key, child_value, indent + 4);
                }
            }
        }
        Value::Array(values) => {
            lines.push(format!("{}{}", prefix, key));
            append_links_array(lines, values, indent + 2);
        }
        _ => lines.push(format!(
            "{}{} {}",
            prefix,
            key,
            format_value_for_links_notation(value)
        )),
    }
}

fn format_record_as_links_notation_with_enrichments(
    record: &ExecutionRecord,
    current_time: Option<&str>,
    process_ids: Option<&Value>,
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

            // Insert processIds right after pid so status output groups process
            // identity with the wrapper PID already present in older output.
            if key == "pid" {
                if let Some(process_ids) = process_ids {
                    append_links_value(&mut lines, "processIds", process_ids, 2);
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
    format_record_as_text_with_enrichments(record, current_time, None)
}

fn append_text_process_ids(lines: &mut Vec<String>, process_ids: &Value) {
    let Value::Object(map) = process_ids else {
        return;
    };
    if map.is_empty() {
        return;
    }

    lines.push("Process IDs:".to_string());
    for (key, value) in map {
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

fn format_record_as_text_with_enrichments(
    record: &ExecutionRecord,
    current_time: Option<&str>,
    process_ids: Option<&Value>,
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
    ];
    if let Some(oom_killed) = record.oom_killed {
        lines.push(format!("OOM Killed:        {}", oom_killed));
    }
    lines.push(format!("PID:               {}", pid_str));
    if let Some(process_ids) = process_ids {
        append_text_process_ids(&mut lines, process_ids);
    }
    lines.extend([
        format!("Working Directory: {}", record.working_directory),
        format!("Shell:             {}", record.shell),
        format!("Platform:          {}", record.platform),
        format!("Start Time:        {}", record.start_time),
    ]);
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

fn record_json_with_enrichments(
    record: &ExecutionRecord,
    current_time: Option<&str>,
    process_ids: Option<&Value>,
) -> Value {
    let mut json = record.to_json();
    if let Value::Object(map) = &mut json {
        if let Some(process_ids) = process_ids {
            map.insert("processIds".to_string(), process_ids.clone());
        }
        if let Some(ct) = current_time {
            map.insert("currentTime".to_string(), Value::String(ct.to_string()));
        }
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
    format_record_with_enrichments(record, format, current_time, None)
}

fn format_record_with_enrichments(
    record: &ExecutionRecord,
    format: &str,
    current_time: Option<&str>,
    process_ids: Option<&Value>,
) -> Result<String, String> {
    match format {
        "links-notation" => Ok(format_record_as_links_notation_with_enrichments(
            record,
            current_time,
            process_ids,
        )),
        "json" => serde_json::to_string_pretty(&record_json_with_enrichments(
            record,
            current_time,
            process_ids,
        ))
        .map_err(|e| format!("Failed to serialize to JSON: {}", e)),
        "text" => Ok(format_record_as_text_with_enrichments(
            record,
            current_time,
            process_ids,
        )),
        _ => Err(format!("Unknown output format: {}", format)),
    }
}

fn sort_records_by_start_time_desc(records: &mut [ExecutionRecord]) {
    records.sort_by(|a, b| b.start_time.cmp(&a.start_time));
}

fn indent_block(block: &str, spaces: usize) -> String {
    let prefix = " ".repeat(spaces);
    block
        .lines()
        .map(|line| format!("{}{}", prefix, line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Format execution records as a Links Notation list.
pub fn format_record_list_as_links_notation(records: &[ExecutionRecord]) -> String {
    let current_times: Vec<Option<String>> = records.iter().map(attach_current_time).collect();
    let process_ids = vec![None; records.len()];
    format_record_list_as_links_notation_with_current_times(records, &current_times, &process_ids)
}

fn format_record_list_as_links_notation_with_current_times(
    records: &[ExecutionRecord],
    current_times: &[Option<String>],
    process_ids: &[Option<Value>],
) -> String {
    let mut lines = vec![
        "executions".to_string(),
        format!("  count {}", records.len()),
    ];

    if records.is_empty() {
        lines.push("  records ()".to_string());
        return lines.join("\n");
    }

    lines.push("  records".to_string());
    for ((record, current_time), process_ids) in records
        .iter()
        .zip(current_times.iter())
        .zip(process_ids.iter())
    {
        let block = format_record_as_links_notation_with_enrichments(
            record,
            current_time.as_deref(),
            process_ids.as_ref(),
        );
        lines.push(indent_block(&block, 4));
    }

    lines.join("\n")
}

/// Format execution records as human-readable text.
pub fn format_record_list_as_text(records: &[ExecutionRecord]) -> String {
    let current_times: Vec<Option<String>> = records.iter().map(attach_current_time).collect();
    let process_ids = vec![None; records.len()];
    format_record_list_as_text_with_current_times(records, &current_times, &process_ids)
}

fn format_record_list_as_text_with_current_times(
    records: &[ExecutionRecord],
    current_times: &[Option<String>],
    process_ids: &[Option<Value>],
) -> String {
    let mut lines = vec![
        "Executions".to_string(),
        "=".repeat(50),
        format!("Count: {}", records.len()),
    ];

    for ((record, current_time), process_ids) in records
        .iter()
        .zip(current_times.iter())
        .zip(process_ids.iter())
    {
        lines.push(String::new());
        lines.push(format_record_as_text_with_enrichments(
            record,
            current_time.as_deref(),
            process_ids.as_ref(),
        ));
    }

    lines.join("\n")
}

fn record_list_json_with_current_times(
    records: &[ExecutionRecord],
    current_times: &[Option<String>],
    process_ids: &[Option<Value>],
) -> Value {
    let executions: Vec<Value> = records
        .iter()
        .zip(current_times.iter())
        .zip(process_ids.iter())
        .map(|((record, current_time), process_ids)| {
            record_json_with_enrichments(record, current_time.as_deref(), process_ids.as_ref())
        })
        .collect();

    serde_json::json!({
        "count": records.len(),
        "executions": executions,
    })
}

/// Format execution records based on format type.
pub fn format_record_list(records: &[ExecutionRecord], format: &str) -> Result<String, String> {
    let current_times: Vec<Option<String>> = records.iter().map(attach_current_time).collect();
    let process_ids = vec![None; records.len()];
    format_record_list_with_current_times(records, format, &current_times, &process_ids)
}

fn format_record_list_with_current_times(
    records: &[ExecutionRecord],
    format: &str,
    current_times: &[Option<String>],
    process_ids: &[Option<Value>],
) -> Result<String, String> {
    match format {
        "links-notation" => Ok(format_record_list_as_links_notation_with_current_times(
            records,
            current_times,
            process_ids,
        )),
        "json" => serde_json::to_string_pretty(&record_list_json_with_current_times(
            records,
            current_times,
            process_ids,
        ))
        .map_err(|e| format!("Failed to serialize to JSON: {}", e)),
        "text" => Ok(format_record_list_as_text_with_current_times(
            records,
            current_times,
            process_ids,
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

/// Handle execution list query and return the result
pub fn list_executions(
    store: Option<&ExecutionStore>,
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

    let mut records: Vec<ExecutionRecord> =
        store.get_all().iter().map(enrich_detached_status).collect();
    sort_records_by_start_time_desc(&mut records);
    let current_times: Vec<Option<String>> = records.iter().map(attach_current_time).collect();
    let process_ids: Vec<Option<Value>> = records.iter().map(collect_process_ids).collect();
    let format = output_format.unwrap_or("links-notation");

    match format_record_list_with_current_times(&records, format, &current_times, &process_ids) {
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
    let process_ids = collect_process_ids(&enriched);

    let format = output_format.unwrap_or("links-notation");
    match format_record_with_enrichments(
        &enriched,
        format,
        current_time.as_deref(),
        process_ids.as_ref(),
    ) {
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
    use crate::execution_store::{ExecutionRecordOptions, ExecutionStoreOptions};
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::Path;
    use tempfile::TempDir;

    fn executing_record() -> ExecutionRecord {
        ExecutionRecord::with_options(ExecutionRecordOptions {
            command: "sleep 60".to_string(),
            uuid: Some("issue-126-rust".to_string()),
            pid: Some(667105),
            status: Some(ExecutionStatus::Executing),
            log_path: Some("/tmp/issue-126.log".to_string()),
            start_time: Some("2026-04-23T10:00:00Z".to_string()),
            working_directory: Some("/home/user".to_string()),
            shell: Some("/bin/bash".to_string()),
            platform: Some("linux".to_string()),
            ..Default::default()
        })
    }

    fn docker_record() -> ExecutionRecord {
        let mut options = HashMap::new();
        options.insert(
            "sessionName".to_string(),
            Value::String("issue144-oom".to_string()),
        );
        options.insert("isolated".to_string(), Value::String("docker".to_string()));
        options.insert(
            "isolationMode".to_string(),
            Value::String("detached".to_string()),
        );

        ExecutionRecord::with_options(ExecutionRecordOptions {
            command: "sh -c 'exit 0'".to_string(),
            uuid: Some("issue144-rust".to_string()),
            log_path: Some("/tmp/issue144.log".to_string()),
            options: Some(options),
            ..Default::default()
        })
    }

    fn write_fake_docker(fake_dir: &Path, state_line: &str) {
        #[cfg(windows)]
        {
            let script = [
                "@echo off",
                "if not \"%1\"==\"inspect\" exit /b 1",
                "echo %3 | findstr /C:\"State.Pid\" >nul",
                "if %errorlevel%==0 (",
                "  echo fake-container-id 4321",
                "  exit /b 0",
                ")",
                &format!("echo {}", state_line),
                "exit /b 0",
                "",
            ]
            .join("\r\n");
            std::fs::write(fake_dir.join("docker.cmd"), script).unwrap();
        }

        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;

            let script = [
                "#!/bin/sh",
                "[ \"$1\" = \"inspect\" ] || exit 1",
                "case \"$3\" in",
                "  *State.Pid*) echo \"fake-container-id 4321\" ;;",
                &format!("  *) echo \"{}\" ;;", state_line),
                "esac",
                "",
            ]
            .join("\n");
            let docker_path = fake_dir.join("docker");
            std::fs::write(&docker_path, script).unwrap();
            let mut permissions = std::fs::metadata(&docker_path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&docker_path, permissions).unwrap();
        }
    }

    fn with_fake_docker_inspect<F: FnOnce()>(state_line: &str, run: F) {
        let fake_dir = TempDir::new().unwrap();
        write_fake_docker(fake_dir.path(), state_line);
        let original_path = std::env::var_os("PATH");
        let mut paths = vec![fake_dir.path().to_path_buf()];
        if let Some(existing) = original_path.as_ref() {
            paths.extend(std::env::split_paths(existing));
        }
        let joined = std::env::join_paths(paths).unwrap();
        std::env::set_var("PATH", &joined);
        run();
        if let Some(path) = original_path {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
    }

    #[test]
    fn links_notation_indents_nested_process_id_arrays() {
        let process_ids = json!({
            "wrapperPid": 667105,
            "screenPid": 667120,
            "commandPids": [667121, 667122],
        });
        let output = format_record_with_enrichments(
            &executing_record(),
            "links-notation",
            Some("2026-04-23T10:10:13.042Z"),
            Some(&process_ids),
        )
        .expect("links-notation should format");

        assert!(
            output.contains(
                "      commandPids\n        (\n          667121\n          667122\n        )"
            ),
            "processIds should be a nested indented block, output: {}",
            output
        );
        assert!(
            !output.contains("\n(\n"),
            "opening parenthesis must not start at column 1: {}",
            output
        );
    }

    #[test]
    fn docker_oom_killed_is_exposed_in_status_and_list_output() {
        let temp_dir = TempDir::new().unwrap();
        let store = ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(temp_dir.path().to_path_buf()),
            use_links: Some(false),
            verbose: false,
        });
        let record = docker_record();
        store.save(&record).unwrap();

        with_fake_docker_inspect("false 0 true", || {
            let json_result = query_status(Some(&store), "issue144-rust", Some("json"));
            assert!(json_result.success);
            let parsed: Value = serde_json::from_str(&json_result.output.unwrap()).unwrap();
            assert_eq!(parsed["status"], "executed");
            assert_eq!(parsed["exitCode"], 0);
            assert_eq!(parsed["oomKilled"], true);

            let links_result = query_status(Some(&store), "issue144-rust", Some("links-notation"));
            assert!(links_result.success);
            assert!(links_result.output.unwrap().contains("  oomKilled true"));

            let text_result = query_status(Some(&store), "issue144-rust", Some("text"));
            assert!(text_result.success);
            assert!(text_result
                .output
                .unwrap()
                .contains("OOM Killed:        true"));

            let list_result = list_executions(Some(&store), Some("json"));
            assert!(list_result.success);
            let listed: Value = serde_json::from_str(&list_result.output.unwrap()).unwrap();
            assert_eq!(listed["count"], 1);
            assert_eq!(listed["executions"][0]["status"], "executed");
            assert_eq!(listed["executions"][0]["exitCode"], 0);
            assert_eq!(listed["executions"][0]["oomKilled"], true);
        });
    }
}
