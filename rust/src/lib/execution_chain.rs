//! Continuation chains (issue #231): a launch with `--continues <id>` stores
//! the UUID it continues, so a supervisor that relaunches fresh instead of
//! `--resume`-ing in place can still treat every execution of one task as a
//! whole. `--status` prints the chain and `--upload-log` uploads one stream with
//! every execution of it, oldest first.
use crate::execution_identity::{execution_aliases, has_user_names};
use crate::execution_store::{ExecutionRecord, ExecutionStore};
use crate::log_sanitizer::LogSource;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

fn start_millis(record: &ExecutionRecord) -> i64 {
    chrono::DateTime::parse_from_rfc3339(&record.start_time)
        .map(|t| t.timestamp_millis())
        .unwrap_or(i64::MIN)
}

/// Records of the chain `record` belongs to, oldest first. Backward links
/// come from `continues`; forward, the most recently started record that
/// continues the current one is followed. Cycles stop the walk.
pub fn build_chain(records: &[ExecutionRecord], record: &ExecutionRecord) -> Vec<ExecutionRecord> {
    let mut seen = vec![record.uuid.clone()];
    let mut chain = vec![record.clone()];
    let mut current = record.clone();
    while let Some(previous_id) = current.continues.clone() {
        let Some(previous) = records.iter().find(|r| r.uuid == previous_id) else {
            break;
        };
        if seen.contains(&previous.uuid) {
            break;
        }
        seen.push(previous.uuid.clone());
        chain.insert(0, previous.clone());
        current = previous.clone();
    }
    let mut current = record.clone();
    loop {
        let next = records
            .iter()
            .filter(|r| r.continues.as_deref() == Some(&current.uuid) && !seen.contains(&r.uuid))
            .max_by_key(|r| start_millis(r));
        let Some(next) = next else {
            break;
        };
        seen.push(next.uuid.clone());
        chain.push(next.clone());
        current = next.clone();
    }
    chain
}

/// Resolve `--continues <id>` for a new launch to the UUID it stores.
pub fn resolve_continues(
    store: Option<&ExecutionStore>,
    identifier: &str,
    session_id: &str,
) -> Result<String, String> {
    let store = store.ok_or("--continues requires execution tracking.")?;
    let target = store.get(identifier).ok_or_else(|| {
        format!(
            "No execution found with UUID or session name: {}",
            identifier
        )
    })?;
    if target.uuid == session_id {
        return Err(format!("Execution {} cannot continue itself", session_id));
    }
    Ok(target.uuid)
}

/// Fields `--status` reports right after `uuid`: the names the execution
/// answers to (`aliases`, once `--alias`/`--rename` gave it one) and its
/// continuation `chain`, when it has more than one member.
pub fn status_identity(
    record: &ExecutionRecord,
    store: Option<&ExecutionStore>,
) -> Vec<(String, Value)> {
    let mut fields = Vec::new();
    if has_user_names(record) {
        fields.push(("aliases".to_string(), json!(execution_aliases(record))));
    }
    if let Some(store) = store {
        let records = store.get_all();
        if record.continues.is_some()
            || records
                .iter()
                .any(|r| r.continues.as_deref() == Some(&record.uuid))
        {
            let chain: Vec<String> = build_chain(&records, record)
                .into_iter()
                .map(|r| r.uuid)
                .collect();
            if chain.len() > 1 {
                fields.push(("chain".to_string(), json!(chain)));
            }
        }
    }
    fields
}

fn joined(fields: &[(String, Value)], key: &str, separator: &str) -> Option<String> {
    let (_, value) = fields.iter().find(|(k, _)| k == key)?;
    let items: Vec<&str> = value.as_array()?.iter().filter_map(Value::as_str).collect();
    Some(items.join(separator))
}

/// Text-format lines for the identity fields of a status record.
pub fn identity_text_lines(record: &ExecutionRecord, fields: &[(String, Value)]) -> Vec<String> {
    let mut lines = Vec::new();
    if let Some(aliases) = joined(fields, "aliases", ", ") {
        lines.push(format!("Aliases:           {}", aliases));
    }
    if let Some(continues) = &record.continues {
        lines.push(format!("Continues:         {}", continues));
    }
    if let Some(chain) = joined(fields, "chain", " -> ") {
        lines.push(format!("Chain:             {}", chain));
    }
    lines
}

/// Describe continuation logs in order. The sanitizer opens each log when it
/// reaches that record, so no combined copy or collection of open files is needed.
pub(crate) fn chain_log_sources(chain: &[ExecutionRecord]) -> Vec<LogSource> {
    chain
        .iter()
        .enumerate()
        .map(|(index, record)| {
            let log_path = (!record.log_path.is_empty()).then_some(&record.log_path);
            let header = json!({
                "event": "continuation",
                "uuid": record.uuid,
                "chainIndex": index + 1,
                "chainLength": chain.len(),
                "continues": record.continues,
                "command": record.command,
                "startTime": record.start_time,
                "logPath": log_path,
            });
            LogSource {
                path: record.log_path.clone(),
                header: Some(format!("\n[Start Command Lifecycle] {}\n", header)),
            }
        })
        .collect()
}

/// A materialized chain log for callers that need a filesystem path.
pub struct ChainLog {
    dir: PathBuf,
    pub path: PathBuf,
}

impl Drop for ChainLog {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Materialize a chain in a temporary file, oldest execution first.
pub fn write_chain_log(chain: &[ExecutionRecord]) -> io::Result<ChainLog> {
    let dir = std::env::temp_dir().join(format!("start-chain-log-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir)?;
    let last = chain.last().map(|r| r.uuid.as_str()).unwrap_or("chain");
    let log = ChainLog {
        path: dir.join(format!("{last}.chain.log")),
        dir,
    };
    let mut file = fs::File::create(&log.path)?;
    for LogSource { path, header } in chain_log_sources(chain) {
        file.write_all(header.as_deref().unwrap_or_default().as_bytes())?;
        match fs::File::open(&path) {
            Ok(mut source) if source.metadata().is_ok_and(|metadata| metadata.is_file()) => {
                io::copy(&mut source, &mut file)?;
            }
            _ => writeln!(file, "Log file not found: {path}")?,
        }
    }
    Ok(log)
}

/// Materialize a multi-execution chain for callers that need a combined path.
pub fn prepare_chain_upload(
    store: &ExecutionStore,
    record: &ExecutionRecord,
) -> Result<Option<ChainLog>, String> {
    let chain = build_chain(&store.get_all(), record);
    if chain.len() < 2 {
        return Ok(None);
    }
    write_chain_log(&chain)
        .map(Some)
        .map_err(|error| format!("Could not join chain logs: {error}"))
}
