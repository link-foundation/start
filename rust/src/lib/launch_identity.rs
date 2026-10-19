//! What a new launch may do with its execution id (issue #229).
//!
//! A launch with an explicit `--session-id` that is already tracked used to
//! replace the record and truncate the log. It is now refused unless
//! `--append-attempt` is given, which keeps the record, archives the previous
//! attempt into `attemptHistory`, and appends the new attempt to the same log
//! after a lifecycle header (the layout `--resume` already writes).
//!
//! Two cases keep the earlier behaviour:
//! - the next level of a stacked isolation, which receives the same
//!   `--session-id` from its parent and runs with START_EXECUTION_ID already
//!   set to it (`is_nested_launch_of`);
//! - a generated UUID, which cannot collide.
use crate::args_parser::WrapperOptions;
use crate::execution_attempt::{
    archive_attempt, create_attempt, current_attempt_number, next_attempt_number, ExecutionAttempt,
};
use crate::execution_env::{
    build_execution_env, inherited_attempt, is_nested_launch_of, prefix_with_execution_env,
    ExecutionEnv, ATTEMPT_ENV, EXECUTION_ID_ENV,
};
use crate::execution_identity::find_record;
use crate::execution_store::{ExecutionRecord, ExecutionStatus, ExecutionStore};
use crate::isolation::isolation_log::{append_log_file, write_log_file};
use crate::launch_owner::{has_active_launch, process_alive};
use chrono::Utc;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const LOG_HEADER: &str = "=== Start Command Log ===";

/// How a launch uses its execution id, decided before anything is printed.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    /// Append to the existing log as the next attempt.
    pub append: bool,
    /// Stored record the launch appends an attempt to.
    pub previous: Option<ExecutionRecord>,
    pub attempt_number: u64,
    pub log_path: PathBuf,
    /// Next level of a stacked isolation of the same execution.
    pub nested: bool,
    /// The id was checked, so saving must re-check it under the store lock.
    pub checked: bool,
    /// UUID of the execution this one continues (`--continues`, #231).
    pub continues: Option<String>,
}

impl LaunchPlan {
    /// A launch with a generated id, or without tracking.
    pub fn fresh(log_path: PathBuf) -> Self {
        LaunchPlan {
            append: false,
            previous: None,
            attempt_number: 1,
            log_path,
            nested: false,
            checked: false,
            continues: None,
        }
    }
}

/// Why saving a launch failed.
#[derive(Debug)]
pub enum ClaimError {
    /// Another launch took the id: the launch must not run.
    Refused(String),
    /// Tracking failed; the launch may still run.
    Store(String),
}

pub fn already_exists_message(uuid: &str) -> String {
    format!(
        "execution {} already exists; use $ --resume {} -- <command> to continue it, or pass --append-attempt",
        uuid, uuid
    )
}

/// True while the stored execution may still be running.
pub fn is_execution_live(record: &ExecutionRecord) -> bool {
    if has_active_launch(record) {
        return true;
    }
    if record.status != ExecutionStatus::Executing {
        return false;
    }
    if record
        .options
        .get("isolated")
        .and_then(Value::as_str)
        .is_some()
    {
        return crate::session_probe::probe_session(
            record,
            &crate::execution_control::SystemCommandRunner,
        )
        .alive;
    }
    record.pid.is_some_and(|pid| process_alive(u64::from(pid)))
}

/// Attempts already in a log written without tracking, from its headers.
pub fn count_logged_attempts(log_path: &Path) -> u64 {
    fs::read_to_string(log_path)
        .map(|content| content.matches(LOG_HEADER).count() as u64)
        .unwrap_or(0)
}

fn log_size(log_path: &Path) -> u64 {
    fs::metadata(log_path).map(|m| m.len()).unwrap_or(0)
}

/// Inputs of `preflight_launch`.
pub struct PreflightParams<'a> {
    pub store: Option<&'a ExecutionStore>,
    pub session_id: &'a str,
    pub explicit_session_id: bool,
    pub append_attempt: bool,
    pub log_path: PathBuf,
    /// START_EXECUTION_ID and START_ATTEMPT of this process.
    pub env_execution_id: Option<String>,
    pub env_attempt: Option<String>,
}

/// Decide how a launch uses its execution id; `Err` when it must not run.
pub fn preflight_launch(params: PreflightParams<'_>) -> Result<LaunchPlan, String> {
    let session_id = params.session_id;
    let fresh = LaunchPlan::fresh(params.log_path.clone());
    if !params.explicit_session_id {
        return Ok(fresh);
    }
    if is_nested_launch_of(session_id, params.env_execution_id.as_deref()) {
        return Ok(LaunchPlan {
            nested: true,
            attempt_number: inherited_attempt(params.env_attempt.as_deref()),
            ..fresh
        });
    }
    let existing = params.store.and_then(|store| store.get(session_id));
    if let Some(existing) = existing {
        if existing.uuid != session_id {
            return Err(format!(
                "execution id {} is already used as a name of execution {}; pick another --session-id",
                session_id, existing.uuid
            ));
        }
        if !params.append_attempt {
            return Err(already_exists_message(session_id));
        }
        if is_execution_live(&existing) {
            return Err(format!(
                "execution {} is still running; wait for it to finish or use $ --stop {} before --append-attempt",
                session_id, session_id
            ));
        }
        let log_path = if existing.log_path.is_empty() {
            params.log_path
        } else {
            PathBuf::from(&existing.log_path)
        };
        return Ok(LaunchPlan {
            append: true,
            attempt_number: next_attempt_number(&existing),
            previous: Some(existing),
            log_path,
            checked: true,
            ..fresh
        });
    }
    // Untracked (or deleted) executions are recognised by their log file.
    if params.log_path.exists() {
        if !params.append_attempt {
            return Err(already_exists_message(session_id));
        }
        return Ok(LaunchPlan {
            append: true,
            attempt_number: count_logged_attempts(&params.log_path) + 1,
            checked: true,
            ..fresh
        });
    }
    Ok(LaunchPlan {
        checked: true,
        ..fresh
    })
}

/// Preflight of the CLI: how this launch uses its id (#229) and which
/// execution it continues (#231).
pub fn prepare_launch(
    store: Option<&ExecutionStore>,
    options: &WrapperOptions,
    session_id: &str,
    log_path: PathBuf,
) -> Result<LaunchPlan, String> {
    let mut launch = preflight_launch(PreflightParams {
        store,
        session_id,
        explicit_session_id: options.session_id.is_some(),
        append_attempt: options.append_attempt,
        log_path,
        env_execution_id: std::env::var(EXECUTION_ID_ENV).ok(),
        env_attempt: std::env::var(ATTEMPT_ENV).ok(),
    })?;
    if let Some(identifier) = &options.continues {
        launch.continues = Some(crate::execution_chain::resolve_continues(
            store, identifier, session_id,
        )?);
    }
    Ok(launch)
}

fn option_str(record: &ExecutionRecord, key: &str) -> Option<String> {
    record
        .options
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Turn the record a launch built into the next attempt of `previous`,
/// keeping the identity, history and log of the execution.
pub fn merge_appended_attempt(record: &mut ExecutionRecord, previous: &ExecutionRecord) {
    let mut prior = previous.clone();
    if prior.attempt.is_none() && current_attempt_number(&prior) == 1 {
        // A launch writes a fresh log, so its first attempt starts at offset 0.
        prior.attempt = Some(ExecutionAttempt {
            number: 1,
            started_at: prior.start_time.clone(),
            log_offset: Some(0),
            last_output_at: None,
            launch_accepted_at: None,
            watcher_attached_at: None,
            mode: String::new(),
            previous_session_name: None,
            session_name: None,
            watcher_error: None,
        });
    }
    let session_name = option_str(record, "sessionName");
    let mut attempt = create_attempt(
        &prior,
        "append-attempt",
        session_name.as_deref().unwrap_or(""),
    );
    attempt.session_name = session_name.clone();
    archive_attempt(&mut prior);
    let mut history: Vec<String> = prior
        .options
        .get("sessionNameHistory")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if let Some(old) = option_str(&prior, "sessionName") {
        if Some(&old) != session_name.as_ref() {
            history.push(old);
        }
    }
    let mut unique: Vec<String> = Vec::new();
    for name in history {
        if !unique.contains(&name) {
            unique.push(name);
        }
    }
    record.attempt = Some(attempt);
    record.attempt_history = prior.attempt_history.clone();
    record.start_time = prior.start_time.clone();
    if !prior.log_path.is_empty() {
        record.log_path = prior.log_path.clone();
    }
    if record.continues.is_none() {
        record.continues = prior.continues.clone();
    }
    if !unique.is_empty() {
        record
            .options
            .insert("sessionNameHistory".into(), json!(unique));
    }
    for key in ["aliases", "name", "resumeCount"] {
        if let Some(value) = prior.options.get(key).filter(|v| !is_empty_value(v)) {
            record.options.insert(key.into(), value.clone());
        }
    }
}

fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::String(s) => s.is_empty(),
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    }
}

/// Apply the preflight to the record a launch built: the continued UUID and,
/// for `--append-attempt`, the identity and history of the stored execution.
pub fn apply_launch(record: &mut ExecutionRecord, launch: &LaunchPlan) {
    if let Some(continues) = &launch.continues {
        record.continues = Some(continues.clone());
    }
    if let Some(previous) = &launch.previous {
        merge_appended_attempt(record, previous);
    } else if launch.attempt_number > 1 {
        // A nested level or an untracked log: number the attempt all the same.
        record.attempt = Some(ExecutionAttempt {
            number: launch.attempt_number,
            started_at: Utc::now().to_rfc3339(),
            log_offset: Some(if launch.append {
                log_size(&launch.log_path)
            } else {
                0
            }),
            last_output_at: None,
            launch_accepted_at: None,
            watcher_attached_at: None,
            mode: if launch.nested {
                "nested".into()
            } else {
                "append-attempt".into()
            },
            previous_session_name: None,
            session_name: option_str(record, "sessionName"),
            watcher_error: None,
        });
    }
}

/// Persist the launch's record, refusing if another launch claimed the id in
/// the meantime: a new id must still be free, an appended attempt must still
/// follow the attempt the preflight saw.
pub fn claim_launch(
    store: &ExecutionStore,
    record: &ExecutionRecord,
    launch: &LaunchPlan,
) -> Result<(), ClaimError> {
    if !launch.checked {
        return store.save(record).map_err(ClaimError::Store);
    }
    let mut refused: Option<String> = None;
    let result = store.with_lock(|records| {
        let index = records.iter().position(|r| r.uuid == record.uuid);
        if let Some(previous) = &launch.previous {
            let attempt_of = |r: &ExecutionRecord| r.attempt.as_ref().map_or(0, |a| a.number);
            let claimable = index.is_some_and(|i| {
                !has_active_launch(&records[i]) && attempt_of(&records[i]) == attempt_of(previous)
            });
            if !claimable {
                let message = format!("execution {} was claimed by another launch", record.uuid);
                refused = Some(message.clone());
                return Err(message);
            }
            records[index.unwrap()] = record.clone();
        } else {
            if find_record(records, &record.uuid).is_some() {
                let message = already_exists_message(&record.uuid);
                refused = Some(message.clone());
                return Err(message);
            }
            records.push(record.clone());
        }
        Ok(Some(record.clone()))
    });
    match (result, refused) {
        (Ok(_), _) => Ok(()),
        (Err(_), Some(message)) => Err(ClaimError::Refused(message)),
        (Err(error), None) => Err(ClaimError::Store(error)),
    }
}

/// Header a launch writes into its log: unchanged for a fresh log; for an
/// appended attempt, preceded by a lifecycle line in the format `--resume`
/// writes, so the attempts stay apart.
pub fn launch_log_content(
    content: &str,
    launch: &LaunchPlan,
    record: Option<&ExecutionRecord>,
) -> String {
    if !launch.append {
        return content.to_string();
    }
    let mut lifecycle = json!({
        "event": "attempt-appended",
        "at": Utc::now().to_rfc3339(),
        "uuid": record.map(|r| r.uuid.clone()),
        "attemptNumber": launch.attempt_number,
    });
    if let Some(Value::Object(attempt)) = record
        .and_then(|r| r.attempt.as_ref())
        .and_then(|a| serde_json::to_value(a).ok())
    {
        if let Value::Object(map) = &mut lifecycle {
            map.extend(attempt);
        }
    }
    format!("\n[Start Command Lifecycle] {}\n{}", lifecycle, content)
}

/// Write the launch header: a fresh log, or, for an appended attempt, a
/// lifecycle line and the header after the earlier attempts.
pub fn write_launch_log(
    log_path: &PathBuf,
    content: &str,
    launch: &LaunchPlan,
    record: Option<&ExecutionRecord>,
) -> bool {
    let text = launch_log_content(content, launch, record);
    if launch.append {
        append_log_file(log_path, &text)
    } else {
        write_log_file(log_path, &text)
    }
}

/// START_* variables of a run without a backend session (direct, or
/// `--isolated-user` alone): the session name is empty.
pub fn direct_execution_env(session_id: &str, launch: &LaunchPlan) -> ExecutionEnv {
    build_execution_env(Some(session_id), Some(""), launch.attempt_number)
}

/// Command of an `--isolated-user` run without a backend: `sudo` resets the
/// environment, so the variables are exported by the command itself.
pub fn isolated_user_command(command: &str, session_id: &str, launch: &LaunchPlan) -> String {
    prefix_with_execution_env(command, &direct_execution_env(session_id, launch))
}
