//! Detached completion finalizer (issue #170).
//!
//! A detached Docker session outlives the CLI process that started it: the
//! foreground `start` invocation returns as soon as the container is up, so
//! nobody is left to write the terminal state back into the execution store.
//! The record therefore stayed `executing` forever, with `exitCode: null` and
//! `endTime: null`, and every `--status` query had to re-derive the outcome from
//! scratch — fabricating `endTime` with the current time in the process.
//!
//! The detached completion watcher (see `docker_cleanup`) now re-invokes the
//! `start` binary with a hidden flag once the container is gone, handing over
//! the facts it already read out of a single `docker inspect`. The finalizer is
//! deliberately silent and infallible: it is a short-lived child process on a
//! host whose CLI invocation is long gone, so a bookkeeping failure must never
//! surface as an error in a log the user is reading for the command's output.

use std::path::PathBuf;

use chrono::Utc;
use serde_json::Value;

use crate::docker_post_mortem::{normalize_docker_timestamp, shell_vars};
use crate::execution_store::{
    ExecutionRecord, ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
};
use crate::exit_reason::{describe_exit_code_str, resolve_exit_reason};
use crate::isolation::isolation_log::{read_log_tail, shell_quote, FATAL_MARKER_TAIL_BYTES};

/// Hidden argument the detached watcher re-invokes this binary with.
/// Not part of the public CLI surface: it is an implementation detail of the
/// watcher, and `--help` stays free of it.
pub const INTERNAL_FINALIZE_FLAG: &str = "--internal-finalize-detached-docker";

/// `end_time` came from `docker inspect .State.FinishedAt` — the container's
/// own clock, the only real finish time available.
pub const END_TIME_SOURCE_DOCKER_FINISHED_AT: &str = "docker-finished-at";
/// `end_time` came from the anchored `Finished:` line `start` itself wrote.
pub const END_TIME_SOURCE_LOG_FOOTER: &str = "log-footer";
/// No real finish time exists: this is when the end was *observed*.
pub const END_TIME_SOURCE_OBSERVED_AT: &str = "observed-at";

/// The docker facts the watcher hands over.
#[derive(Debug, Clone, Default)]
pub struct DetachedFinalizeFacts {
    pub exit_code: String,
    pub oom_killed: String,
    pub started_at: String,
    pub finished_at: String,
    pub container_error: String,
}

/// Outcome of a finalization attempt. `updated` is false when there was
/// nothing to correct (or nothing to correct it on).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizeOutcome {
    pub updated: bool,
    pub reason: String,
}

fn normalize_bool(value: &str) -> Option<bool> {
    match value.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn normalize_container_error(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "<no value>" || trimmed == "(none)" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Persist the terminal state of a detached execution.
///
/// Purely additive with respect to the observation-vs-verdict discipline of
/// issues #148/#151/#162: `oom_killed` and `exit_reason` are recorded as facts
/// next to the exit code, never as a substitute for it.
pub fn finalize_detached_execution(
    store: &ExecutionStore,
    execution_id: &str,
    facts: &DetachedFinalizeFacts,
) -> FinalizeOutcome {
    if execution_id.is_empty() {
        return FinalizeOutcome {
            updated: false,
            reason: "missing-arguments".to_string(),
        };
    }
    let mut record = match store.get(execution_id) {
        Some(record) => record,
        None => {
            return FinalizeOutcome {
                updated: false,
                reason: "record-not-found".to_string(),
            }
        }
    };
    if record.status == ExecutionStatus::Executed && record.end_time.is_some() {
        // Already finalized (e.g. a `--status` query got there first, or the
        // watcher ran twice after a resume). Nothing to correct.
        return FinalizeOutcome {
            updated: false,
            reason: "already-final".to_string(),
        };
    }

    let described = describe_exit_code_str(&facts.exit_code);
    record.status = ExecutionStatus::Executed;
    match described.code {
        Some(code) => record.exit_code = Some(code),
        None => {
            if record.exit_code.is_none() {
                record.exit_code = Some(-1);
            }
        }
    }

    match normalize_docker_timestamp(Some(&facts.finished_at)) {
        Some(finished_at) => {
            record.end_time = Some(finished_at);
            record.end_time_source = Some(END_TIME_SOURCE_DOCKER_FINISHED_AT.to_string());
        }
        None => {
            // Docker has no finish time for this container (it never started, or
            // it was removed before we could look). Record *when we noticed*,
            // and say so, rather than passing observation time off as a finish
            // time (issue #170.2).
            let now = Utc::now().to_rfc3339();
            record.end_time = Some(now.clone());
            record.end_time_source = Some(END_TIME_SOURCE_OBSERVED_AT.to_string());
            record.observed_at = Some(now);
        }
    }

    if let Some(started_at) = normalize_docker_timestamp(Some(&facts.started_at)) {
        record.container_started_at = Some(started_at);
    }
    if let Some(oom_killed) = normalize_bool(&facts.oom_killed) {
        record.oom_killed = Some(oom_killed);
    }
    if let Some(reason) = resolve_reason(&record) {
        record.exit_reason = Some(reason);
    }
    if let Some(error) = normalize_container_error(&facts.container_error) {
        record
            .options
            .insert("containerError".to_string(), Value::String(error));
    }

    match store.save(&record) {
        Ok(()) => FinalizeOutcome {
            updated: true,
            reason: "finalized".to_string(),
        },
        Err(error) => FinalizeOutcome {
            updated: false,
            reason: format!("save-failed: {}", error),
        },
    }
}

/// Derive the `exit_reason` hint from the same evidence `--status` would use.
fn resolve_reason(record: &ExecutionRecord) -> Option<String> {
    let tail = if record.log_path.is_empty() {
        None
    } else {
        read_log_tail(&record.log_path, FATAL_MARKER_TAIL_BYTES)
    };
    resolve_exit_reason(record.exit_code, tail.as_deref(), record.oom_killed)
}

/// Reconcile an in-memory record with one the detached watcher already
/// finalized.
///
/// A container that exits almost immediately can be finalized by the watcher
/// before the foreground `start` invocation writes its own last update. Saving
/// the stale in-memory copy would resurrect `status: executing` and throw the
/// terminal facts away, so the stored record wins and only the fields the
/// foreground process learned (its `options`, e.g. `containerId`) are merged in.
pub fn reconcile_finalized_record(
    store: &ExecutionStore,
    record: &ExecutionRecord,
) -> ExecutionRecord {
    let stored = match store.get(&record.uuid) {
        Some(stored) => stored,
        None => return record.clone(),
    };
    if stored.status != ExecutionStatus::Executed || stored.end_time.is_none() {
        return record.clone();
    }
    let mut merged = stored;
    for (key, value) in &record.options {
        merged.options.insert(key.clone(), value.clone());
    }
    merged
}

/// Shell fragment that hands the inspected docker facts to this finalizer.
///
/// Runs the same binary that started the session and is suffixed with
/// `|| true`, so a finalization failure can never abort the watcher's remaining
/// cleanup work.
pub fn build_detached_finalize_snippet(execution_id: &str) -> String {
    let executable = std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| "start".to_string());
    format!(
        "{} {} {} \"${}\" \"${}\" \"${}\" \"${}\" \"${}\" >/dev/null 2>&1 || true",
        shell_quote(&executable),
        INTERNAL_FINALIZE_FLAG,
        shell_quote(execution_id),
        shell_vars::EXIT,
        shell_vars::OOM,
        shell_vars::STARTED,
        shell_vars::FINISHED,
        shell_vars::ERROR,
    )
}

/// Entry point for `--internal-finalize-detached-docker <uuid> <exit> <oom>
/// <started> <finished> <error>`. Always succeeds: see the module docs.
pub fn run_internal_finalize(args: &[String]) {
    let execution_id = match args.first() {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return,
    };
    if std::env::var("START_DISABLE_TRACKING").as_deref() == Ok("true") {
        return;
    }
    let field = |index: usize| args.get(index).cloned().unwrap_or_default();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: std::env::var("START_APP_FOLDER").ok().map(PathBuf::from),
        ..ExecutionStoreOptions::default()
    });
    finalize_detached_execution(
        &store,
        &execution_id,
        &DetachedFinalizeFacts {
            exit_code: field(1),
            oom_killed: field(2),
            started_at: field(3),
            finished_at: field(4),
            container_error: field(5),
        },
    );
}
