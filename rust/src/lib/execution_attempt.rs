//! Attempt boundaries and evidence for executions sharing one UUID/log.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::PathBuf;

use crate::execution_store::ExecutionRecord;
use crate::isolation::isolation_log::{append_log_file, read_log_tail_from};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionAttempt {
    pub number: u64,
    pub started_at: String,
    pub log_offset: Option<u64>,
    pub last_output_at: Option<String>,
    pub launch_accepted_at: Option<String>,
    pub watcher_attached_at: Option<String>,
    pub mode: String,
    pub previous_session_name: Option<String>,
    pub session_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watcher_error: Option<String>,
}

pub fn create_attempt(
    record: &ExecutionRecord,
    mode: &str,
    session_name: &str,
) -> ExecutionAttempt {
    let counter = |key| record.options.get(key).and_then(Value::as_u64).unwrap_or(0);
    let previous = record
        .attempt
        .as_ref()
        .map(|a| a.number)
        .unwrap_or(counter("resumeCount") + counter("recoveryAttempts") + 1);
    let log_offset = if record.log_path.is_empty() {
        None
    } else {
        match fs::metadata(&record.log_path) {
            Ok(metadata) => Some(metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(0),
            Err(_) => None,
        }
    };
    ExecutionAttempt {
        number: previous + 1,
        started_at: Utc::now().to_rfc3339(),
        log_offset,
        last_output_at: None,
        launch_accepted_at: None,
        watcher_attached_at: None,
        mode: mode.into(),
        previous_session_name: record
            .options
            .get("sessionName")
            .and_then(Value::as_str)
            .map(str::to_string),
        session_name: Some(session_name.into()),
        watcher_error: None,
    }
}

pub fn archive_attempt(record: &mut ExecutionRecord) {
    read_attempt_activity(record);
    let value = serde_json::to_value(&*record).unwrap_or_default();
    let mut snapshot = record.attempt.as_ref().and_then(|a| serde_json::to_value(a).ok())
        .unwrap_or_else(|| json!({ "number": record.options.get("resumeCount").and_then(Value::as_u64).unwrap_or(0)
            + record.options.get("recoveryAttempts").and_then(Value::as_u64).unwrap_or(0) + 1,
            "startedAt": record.options.get("resumedAt").cloned().unwrap_or(json!(record.start_time)), "logOffset": null }));
    for key in [
        "command",
        "status",
        "exitCode",
        "endTime",
        "endTimeSource",
        "observedAt",
        "staleDetectedAt",
        "containerStartedAt",
        "exitReason",
        "oomKilled",
        "memoryExhausted",
        "memoryExhaustedReason",
        "cgroupMemory",
    ] {
        if let Some(field) = value.get(key) {
            snapshot[key] = field.clone();
        }
    }
    for key in ["sessionName", "containerId", "containerError"] {
        snapshot[key] = record.options.get(key).cloned().unwrap_or(Value::Null);
    }
    record.attempt_history.push(snapshot);
    record.end_time_source = None;
    record.observed_at = None;
    record.stale_detected_at = None;
    record.container_started_at = None;
    record.exit_reason = None;
    record.oom_killed = None;
    record.memory_exhausted = None;
    record.memory_exhausted_reason = None;
    record.cgroup_memory = None;
    record.options.remove("containerError");
}

pub fn append_lifecycle(record: &ExecutionRecord, event: &str, details: Value) {
    if let Some(attempt) = &record.attempt {
        if record.log_path.is_empty() {
            return;
        }
        let mut entry = serde_json::to_value(attempt).unwrap_or_default();
        entry["event"] = json!(event);
        entry["at"] = json!(Utc::now().to_rfc3339());
        entry["uuid"] = json!(record.uuid);
        entry["attemptNumber"] = json!(attempt.number);
        if let Some(details) = details.as_object() {
            for (key, value) in details {
                entry[key] = value.clone();
            }
        }
        append_log_file(
            &PathBuf::from(&record.log_path),
            &format!("\n[Start Command Lifecycle] {}\n", entry),
        );
    }
}

pub fn read_attempt_log_tail(record: &ExecutionRecord, bytes: u64) -> Option<String> {
    let offset = match &record.attempt {
        Some(attempt) => attempt.log_offset?,
        None => 0,
    };
    read_log_tail_from(&record.log_path, bytes, offset)
}

pub fn activity_path(log_path: &str, number: u64) -> String {
    format!("{}.attempt-{}.activity", log_path, number)
}

pub fn read_attempt_activity(record: &mut ExecutionRecord) {
    let Some(attempt) = record.attempt.as_mut() else {
        return;
    };
    if record.log_path.is_empty() {
        return;
    }
    let Ok(file) = fs::File::open(activity_path(&record.log_path, attempt.number)) else {
        return;
    };
    let mut text = String::new();
    if file.take(128).read_to_string(&mut text).is_err() {
        return;
    }
    let time = DateTime::parse_from_rfc3339(text.trim());
    let since = DateTime::parse_from_rfc3339(&attempt.started_at);
    if let (Ok(time), Ok(since)) = (time, since) {
        if time >= since {
            attempt.last_output_at = Some(text.trim().into());
        }
    }
}
