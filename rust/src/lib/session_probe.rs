//! Session liveness probing for tracked executions.
//!
//! `--attach`, `--resume` and `--resume-all` all need the same question
//! answered first: is the isolation session behind this execution record still
//! alive, stopped but recoverable, or gone entirely? The probe never mutates
//! anything, so it is safe to run against every tracked record.

use crate::docker_cleanup::docker_command;
use crate::execution_control::CommandRunner;
use crate::execution_store::ExecutionRecord;

/// States a tracked isolation session can be observed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// The session/container is alive and can be attached to.
    Running,
    /// The container still exists but is not running (resumable).
    Stopped,
    /// No trace of the session/container remains.
    Missing,
    /// The backend cannot be probed locally (e.g. ssh).
    Unknown,
}

impl SessionState {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionState::Running => "running",
            SessionState::Stopped => "stopped",
            SessionState::Missing => "missing",
            SessionState::Unknown => "unknown",
        }
    }
}

/// Observation about the isolation session behind an execution record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionProbe {
    pub backend: Option<String>,
    pub session_name: Option<String>,
    pub state: SessionState,
    pub alive: bool,
    pub container_status: Option<String>,
}

impl Default for SessionProbe {
    fn default() -> Self {
        SessionProbe {
            backend: None,
            session_name: None,
            state: SessionState::Unknown,
            alive: false,
            container_status: None,
        }
    }
}

/// Map a `docker inspect -f {{.State.Status}}` value to a session state.
pub fn map_docker_status_to_state(status: Option<&str>) -> SessionState {
    let normalized = status.unwrap_or("").trim().to_lowercase();
    if normalized.is_empty() {
        return SessionState::Unknown;
    }
    if normalized == "running" || normalized == "restarting" {
        return SessionState::Running;
    }
    SessionState::Stopped
}

/// Find a session in `screen -ls` output.
///
/// Session names are matched exactly against the `<pid>.<name>` column so a
/// prefix like "session" never matches "my-session".
pub fn parse_screen_session_state(output: &str, session_name: &str) -> SessionState {
    for line in output.lines() {
        let first_column = line.split_whitespace().next().unwrap_or("");
        let Some((pid, name)) = first_column.split_once('.') else {
            continue;
        };
        if !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit()) && name == session_name {
            return SessionState::Running;
        }
    }
    SessionState::Missing
}

fn record_option<'a>(record: &'a ExecutionRecord, key: &str) -> Option<&'a str> {
    record.options.get(key).and_then(|value| value.as_str())
}

/// Probe the isolation session behind an execution record.
pub fn probe_session<R: CommandRunner>(record: &ExecutionRecord, runner: &R) -> SessionProbe {
    let backend = record_option(record, "isolated").map(str::to_string);
    let session_name = record_option(record, "sessionName").map(str::to_string);

    let mut probe = SessionProbe {
        backend: backend.clone(),
        session_name: session_name.clone(),
        ..SessionProbe::default()
    };

    let (Some(backend), Some(session_name)) = (backend, session_name) else {
        return probe;
    };

    match backend.as_str() {
        "docker" => {
            let docker = docker_command().to_string_lossy().to_string();
            let result = runner.run(
                &docker,
                &[
                    "inspect".to_string(),
                    "-f".to_string(),
                    "{{.State.Status}}".to_string(),
                    session_name,
                ],
            );
            if !result.success {
                probe.state = SessionState::Missing;
                return probe;
            }
            let status = result.stdout.trim().to_string();
            probe.container_status = (!status.is_empty()).then_some(status);
            probe.state = map_docker_status_to_state(probe.container_status.as_deref());
        }
        "screen" => {
            let result = runner.run("screen", &["-ls".to_string()]);
            // `screen -ls` exits non-zero even when it lists sessions, so the
            // output is authoritative, not the exit status.
            let combined = format!("{}{}", result.stdout, result.stderr);
            probe.state = parse_screen_session_state(&combined, &session_name);
        }
        "tmux" => {
            let result = runner.run(
                "tmux",
                &["has-session".to_string(), "-t".to_string(), session_name],
            );
            probe.state = if result.success {
                SessionState::Running
            } else {
                SessionState::Missing
            };
        }
        _ => {}
    }

    probe.alive = probe.state == SessionState::Running;
    probe
}

#[cfg(test)]
#[path = "session_probe_cases.rs"]
mod tests;
