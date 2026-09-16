//! Status formatter module for execution records
//!
//! Provides formatting functions for execution status output in various formats:
//! - Links Notation (links-notation): Structured link doublet format with nested options
//! - JSON: Standard JSON output
//! - Text: Human-readable text format

use crate::execution_control::collect_process_ids;
use crate::execution_store::{ExecutionRecord, ExecutionStatus, ExecutionStore};
use crate::exit_reason::{describe_exit_code, resolve_exit_reason, resolve_memory_exhaustion};
use crate::isolation::isolation_log::{read_log_tail, FATAL_MARKER_TAIL_BYTES};
use crate::output_blocks::{escape_for_links_notation, format_value_for_links_notation};
use crate::status_footer::read_footer_from_log;
use crate::status_probe::{
    apply_end_time, backend_exit_code, is_detached_docker_record, is_detached_session_alive,
    read_docker_state, resolve_oom_observation,
};
use chrono::Utc;
use serde_json::Value;

/// Read the terminal exit code from the anchored footer at the end of a log.
///
/// Thin wrapper kept for compatibility: the footer itself is parsed by
/// `status_footer`, which also returns the `Finished:` timestamp callers need
/// for `end_time` (issue #170.2).
pub fn read_exit_code_from_log(log_path: &str) -> Option<i32> {
    read_footer_from_log(log_path).exit_code
}

/// Enrich execution record with live session status and an exit reason hint.
///
/// The hint explains an otherwise opaque exit code (`139` with `oomKilled
/// false` is the motivating case from issue #162) and is derived from the same
/// log tail the footer scan already reads. It is purely additive: `status`,
/// `exitCode` and `oomKilled` are never changed by it. The same tail also
/// yields the `memoryExhausted` observation for consumers that key off
/// `oomKilled` (issue #165).
pub fn enrich_detached_status(record: &ExecutionRecord) -> ExecutionRecord {
    let mut enriched = resolve_detached_status(record);
    if enriched.status != ExecutionStatus::Executed {
        return enriched;
    }
    let tail = read_log_tail(&enriched.log_path, FATAL_MARKER_TAIL_BYTES);
    if enriched.exit_reason.is_none() {
        enriched.exit_reason =
            resolve_exit_reason(enriched.exit_code, tail.as_deref(), enriched.oom_killed);
    }
    if enriched.memory_exhausted.is_none() {
        if let Some(memory) =
            resolve_memory_exhaustion(enriched.exit_code, tail.as_deref(), enriched.oom_killed)
        {
            enriched.memory_exhausted = Some(memory.memory_exhausted);
            enriched.memory_exhausted_reason = Some(memory.memory_exhausted_reason);
        }
    }
    enriched
}

/// Reconcile the stored status of a detached execution with its live session.
/// If a record shows "executing" but the detached session has actually ended,
/// returns an updated copy with status "executed". If it shows "executed" but
/// the session is still running, returns a copy with status "executing".
fn resolve_detached_status(record: &ExecutionRecord) -> ExecutionRecord {
    let footer = read_footer_from_log(&record.log_path);
    let footer_exit = footer.exit_code;
    let is_detached_docker = is_detached_docker_record(record);
    let docker_state = if is_detached_docker {
        read_docker_state(record)
    } else {
        None
    };

    // `oomKilled` is exposed alongside the status, but never decides it (#151).
    let oom_killed = resolve_oom_observation(record, docker_state.as_ref());
    let clone_record = || {
        let mut enriched = record.clone();
        if oom_killed.is_some() {
            enriched.oom_killed = oom_killed;
        }
        enriched
    };

    let alive = if is_detached_docker {
        docker_state.as_ref().map(|state| state.running)
    } else {
        is_detached_session_alive(record)
    };

    let alive = match alive {
        Some(value) => value,
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
            if is_detached && record.status == ExecutionStatus::Executing {
                if footer_exit.is_some() {
                    let mut enriched = clone_record();
                    enriched.status = ExecutionStatus::Executed;
                    enriched.exit_code = footer_exit;
                    apply_end_time(&mut enriched, docker_state.as_ref(), &footer);
                    return enriched;
                }
                if oom_killed == Some(true) {
                    // The container is gone and wrote no footer, so the OOM
                    // observation is the only evidence left: report the session
                    // as finished with the conventional SIGKILL code (issue
                    // #148). While the container is still inspectable this
                    // branch is never taken — a live container keeps the session
                    // `executing` no matter what the cgroup flag says (#151).
                    let mut enriched = clone_record();
                    enriched.status = ExecutionStatus::Executed;
                    enriched.exit_code = Some(137);
                    apply_end_time(&mut enriched, docker_state.as_ref(), &footer);
                    return enriched;
                }
            }
            return clone_record();
        }
    };

    let mut enriched = clone_record();

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
            enriched.end_time_source = None;
        }
        // Otherwise keep the recorded/footer exit code - the command has finished.
    } else if !alive && enriched.status == ExecutionStatus::Executing {
        // Session ended but record says executing - correct it. Resolve a real
        // exit code: prefer the backend's own record (e.g. `docker inspect
        // .State.ExitCode`, which is authoritative and cannot be spoofed by
        // command output — issue #150), then the anchored log footer, then
        // `137` when the only evidence left is the OOM observation, and only
        // fall back to the `-1` sentinel as a last resort when no real code can
        // be obtained (issues #136, #151).
        enriched.status = ExecutionStatus::Executed;
        if enriched.exit_code.is_none() {
            enriched.exit_code = Some(
                backend_exit_code(docker_state.as_ref())
                    .or(footer_exit)
                    .or(if oom_killed == Some(true) {
                        Some(137)
                    } else {
                        None
                    })
                    .unwrap_or(-1),
            );
        }
        apply_end_time(&mut enriched, docker_state.as_ref(), &footer);
    }

    enriched
}

/// Compute a `currentTime` value for a record if its status is `executing`.
/// Returns `None` for completed records. Wrapping this in a helper makes it
/// easy to attach the same timestamp to all output formats and to test the
/// behavior deterministically.
pub fn attach_current_time(record: &ExecutionRecord) -> Option<String> {
    if record.status == ExecutionStatus::Executing {
        Some(Utc::now().to_rfc3339())
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
        // Decoded through the same helper the completion watcher generates its
        // `case` table from, so `137` reads as `137 (SIGKILL - 128+9)` here and
        // in the log post-mortem alike (issue #171.4).
        .map(|c| describe_exit_code(Some(c)).text)
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
    if let Some(ref exit_reason) = record.exit_reason {
        lines.push(format!("Exit Reason:       {}", exit_reason));
    }
    if let Some(memory_exhausted) = record.memory_exhausted {
        lines.push(format!("Memory Exhausted:  {}", memory_exhausted));
    }
    if let Some(ref reason) = record.memory_exhausted_reason {
        lines.push(format!("Memory Evidence:   {}", reason));
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
    if let Some(ref source) = record.end_time_source {
        // Where `End Time` came from: a real finish time, or merely when
        // `start` noticed the execution was over (issue #170.2).
        lines.push(format!("End Time Source:   {}", source));
    }
    if let Some(ref started) = record.container_started_at {
        lines.push(format!("Container Started: {}", started));
    }
    if let Some(ref detected) = record.stale_detected_at {
        lines.push(format!("Stale Detected At: {}", detected));
    }
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
    list_executions_filtered(store, output_format, false)
}

/// Handle execution list query, optionally keeping only running executions.
///
/// `--list --running` reports the reconciled status, not the stored one: a
/// record whose session already died is dropped even if the store still says
/// "executing" (issue #162).
pub fn list_executions_filtered(
    store: Option<&ExecutionStore>,
    output_format: Option<&str>,
    running_only: bool,
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
    if running_only {
        records.retain(|record| record.status == ExecutionStatus::Executing);
    }
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
    use crate::execution_store::ExecutionRecordOptions;
    use serde_json::json;

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
}
