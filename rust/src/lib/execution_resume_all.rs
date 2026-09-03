//! `--resume-all`: re-attach or reconcile every execution still marked running.
//!
//! When the supervisor host restarts, the detached docker completion watcher
//! (`docker logs -f ... ; docker inspect ... ; footer`) dies with it. The
//! container keeps running but nothing streams its output into the session log
//! any more, and nothing will ever write the exit footer — the record stays
//! `executing` forever. `--resume-all` repairs that state:
//!
//! - reattached: a live docker container gets a fresh completion watcher.
//! - running: a live screen/tmux session needs nothing (its logging is
//!   in-session), it is only reported.
//! - reconciled: the session is gone, so the record is finalized from the same
//!   evidence `--status` uses (docker exit code, log footer).
//! - unknown: the backend cannot be probed locally (ssh), left untouched.
//!
//! Commands are never silently restarted here: resuming actual work is an
//! explicit, per-session decision made with `--resume`.

use serde_json::json;

use crate::execution_control::{CommandRunner, SystemCommandRunner};
use crate::execution_resume::{ResumeHooks, SystemResumeHooks};
use crate::execution_store::{ExecutionRecord, ExecutionStatus, ExecutionStore};
use crate::output_blocks::escape_for_links_notation;
use crate::session_probe::{probe_session, SessionProbe, SessionState};

/// Outcomes reported for each execution that was still marked running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeAllAction {
    Reattached,
    Running,
    Reconciled,
    Unknown,
}

impl ResumeAllAction {
    pub fn as_str(self) -> &'static str {
        match self {
            ResumeAllAction::Reattached => "reattached",
            ResumeAllAction::Running => "running",
            ResumeAllAction::Reconciled => "reconciled",
            ResumeAllAction::Unknown => "unknown",
        }
    }
}

/// One line of the `--resume-all` report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeAllEntry {
    pub uuid: String,
    pub backend: Option<String>,
    pub session_name: Option<String>,
    pub state: SessionState,
    pub action: ResumeAllAction,
    pub exit_code: Option<i32>,
    pub message: String,
}

/// Result of `resume_all_executions`.
pub struct ExecutionResumeAllResult {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}

fn describe_record(
    record: &ExecutionRecord,
    probe: &SessionProbe,
    action: ResumeAllAction,
    message: String,
    exit_code: Option<i32>,
) -> ResumeAllEntry {
    ResumeAllEntry {
        uuid: record.uuid.clone(),
        backend: probe.backend.clone().or_else(|| {
            record
                .options
                .get("isolated")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        }),
        session_name: probe.session_name.clone().or_else(|| {
            record
                .options
                .get("sessionName")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        }),
        state: probe.state,
        action,
        exit_code,
        message,
    }
}

fn format_as_links_notation(entries: &[ResumeAllEntry]) -> String {
    let mut lines = vec![
        "executionResumeAll".to_string(),
        format!("  count {}", entries.len()),
    ];
    for entry in entries {
        lines.push("  execution".to_string());
        lines.push(format!(
            "    uuid {}",
            escape_for_links_notation(&entry.uuid)
        ));
        lines.push(format!(
            "    backend {}",
            escape_for_links_notation(entry.backend.as_deref().unwrap_or(""))
        ));
        lines.push(format!(
            "    sessionName {}",
            escape_for_links_notation(entry.session_name.as_deref().unwrap_or(""))
        ));
        lines.push(format!(
            "    state {}",
            escape_for_links_notation(entry.state.as_str())
        ));
        lines.push(format!(
            "    action {}",
            escape_for_links_notation(entry.action.as_str())
        ));
        if let Some(exit_code) = entry.exit_code {
            lines.push(format!("    exitCode {}", exit_code));
        }
        lines.push(format!(
            "    message {}",
            escape_for_links_notation(&entry.message)
        ));
    }
    lines.join("\n")
}

fn format_as_text(entries: &[ResumeAllEntry]) -> String {
    if entries.is_empty() {
        return "No executions are currently marked as running.".to_string();
    }
    let mut lines = vec![
        format!("Executions still marked running: {}", entries.len()),
        String::new(),
    ];
    for entry in entries {
        lines.push(format!(
            "{}  {}",
            entry.action.as_str().to_uppercase(),
            entry.uuid
        ));
        lines.push(format!(
            "  Backend:      {}",
            entry.backend.as_deref().unwrap_or("")
        ));
        lines.push(format!(
            "  Session Name: {}",
            entry.session_name.as_deref().unwrap_or("")
        ));
        lines.push(format!("  State:        {}", entry.state.as_str()));
        lines.push(format!("  {}", entry.message));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn format_as_json(entries: &[ResumeAllEntry]) -> String {
    let executions: Vec<_> = entries
        .iter()
        .map(|entry| {
            json!({
                "uuid": entry.uuid,
                "backend": entry.backend,
                "sessionName": entry.session_name,
                "state": entry.state.as_str(),
                "action": entry.action.as_str(),
                "exitCode": entry.exit_code,
                "message": entry.message,
            })
        })
        .collect();
    serde_json::to_string_pretty(&json!({
        "count": entries.len(),
        "executions": executions,
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

/// Format a `--resume-all` report in the requested output format.
pub fn format_resume_all(entries: &[ResumeAllEntry], output_format: Option<&str>) -> String {
    match output_format {
        Some("json") => format_as_json(entries),
        Some("text") => format_as_text(entries),
        _ => format_as_links_notation(entries),
    }
}

/// Re-attach or reconcile every execution still marked running.
pub fn resume_all_executions(
    store: Option<&ExecutionStore>,
    output_format: Option<&str>,
) -> ExecutionResumeAllResult {
    resume_all_executions_with(
        store,
        output_format,
        &SystemCommandRunner,
        &SystemResumeHooks,
    )
}

/// Re-attach or reconcile with an injectable command runner and hooks.
pub fn resume_all_executions_with<R: CommandRunner, H: ResumeHooks>(
    store: Option<&ExecutionStore>,
    output_format: Option<&str>,
    runner: &R,
    hooks: &H,
) -> ExecutionResumeAllResult {
    let Some(store) = store else {
        return ExecutionResumeAllResult {
            success: false,
            output: None,
            error: Some("Execution tracking is disabled.".to_string()),
        };
    };

    let mut entries: Vec<ResumeAllEntry> = Vec::new();

    for record in store.get_executing() {
        let probe = probe_session(&record, runner);
        let session_name = probe.session_name.clone().unwrap_or_default();

        if probe.alive && probe.backend.as_deref() == Some("docker") {
            hooks.start_watcher(&session_name, &record);
            entries.push(describe_record(
                &record,
                &probe,
                ResumeAllAction::Reattached,
                format!(
                    "Re-attached completion watcher to running container: {}",
                    session_name
                ),
                None,
            ));
            continue;
        }

        if probe.alive {
            entries.push(describe_record(
                &record,
                &probe,
                ResumeAllAction::Running,
                format!("Session is still running: {}", session_name),
                None,
            ));
            continue;
        }

        if probe.state == SessionState::Unknown {
            entries.push(describe_record(
                &record,
                &probe,
                ResumeAllAction::Unknown,
                format!(
                    "Session liveness cannot be probed locally: {}",
                    if session_name.is_empty() {
                        record.uuid.clone()
                    } else {
                        session_name.clone()
                    }
                ),
                None,
            ));
            continue;
        }

        let reconciled = hooks.reconcile(&record);
        if reconciled.status == ExecutionStatus::Executed {
            let exit_code = reconciled.exit_code;
            let _ = store.save(&reconciled);
            entries.push(describe_record(
                &record,
                &probe,
                ResumeAllAction::Reconciled,
                format!(
                    "Session ended while unsupervised; record finalized. Use `$ --resume {}` to continue it.",
                    record.uuid
                ),
                exit_code,
            ));
            continue;
        }

        entries.push(describe_record(
            &record,
            &probe,
            ResumeAllAction::Unknown,
            format!(
                "Session is not running but no terminal result could be resolved: {}",
                if session_name.is_empty() {
                    record.uuid.clone()
                } else {
                    session_name.clone()
                }
            ),
            None,
        ));
    }

    ExecutionResumeAllResult {
        success: true,
        output: Some(format_resume_all(&entries, output_format)),
        error: None,
    }
}

#[cfg(test)]
#[path = "execution_resume_all_cases.rs"]
mod tests;
