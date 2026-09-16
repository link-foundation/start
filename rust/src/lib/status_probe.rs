//! Live probing of a detached execution's backend.
//!
//! Split out of `status_formatter` so that "what is this session doing right
//! now" (a `docker inspect`, a `screen -ls`, a `/proc` lookup) stays separate
//! from "how do we render a record". Both halves are needed by `--status`, and
//! together they no longer fit in one file under the repository's 1000-line
//! budget.

use crate::detached_finalize::{
    END_TIME_SOURCE_DOCKER_FINISHED_AT, END_TIME_SOURCE_LOG_FOOTER, END_TIME_SOURCE_OBSERVED_AT,
};
use crate::docker_cleanup::docker_command;
use crate::docker_post_mortem::normalize_docker_timestamp;
use crate::execution_store::ExecutionRecord;
use crate::status_footer::LogFooter;
use chrono::Utc;
use std::process::Command;

/// Live state of a detached docker container by name.
#[derive(Clone, Default)]
pub struct DockerState {
    pub running: bool,
    exit_code: Option<i32>,
    oom_killed: Option<bool>,
    /// `.State.StartedAt`, normalized (issue #171.1).
    started_at: Option<String>,
    /// `.State.FinishedAt`, normalized — the authoritative finish time of a
    /// detached container, and the reason `--status` no longer has to invent
    /// one (issue #170.2).
    finished_at: Option<String>,
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
pub(crate) fn inspect_docker_state(session_name: &str) -> Option<DockerState> {
    let output = Command::new(docker_command())
        .args([
            "inspect",
            "-f",
            concat!(
                "{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}} ",
                "{{.State.StartedAt}} {{.State.FinishedAt}}"
            ),
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
    let started_at = normalize_docker_timestamp(parts.next());
    let finished_at = normalize_docker_timestamp(parts.next());
    Some(DockerState {
        running,
        exit_code,
        oom_killed,
        started_at,
        finished_at,
    })
}

pub(crate) fn is_detached_docker_record(record: &ExecutionRecord) -> bool {
    record.options.get("isolated").and_then(|v| v.as_str()) == Some("docker")
        && record.options.get("isolationMode").and_then(|v| v.as_str()) == Some("detached")
        && record
            .options
            .get("sessionName")
            .and_then(|v| v.as_str())
            .is_some()
}

pub(crate) fn read_docker_state(record: &ExecutionRecord) -> Option<DockerState> {
    if record.options.get("isolated")?.as_str()? != "docker" {
        return None;
    }
    let session_name = record.options.get("sessionName")?.as_str()?;
    inspect_docker_state(session_name)
}

/// Best-effort terminal exit code reported by the isolation backend itself
/// (currently docker via `docker inspect .State.ExitCode`). Returns None when
/// the backend cannot provide a real code, so callers never surface the `-1`
/// sentinel for a session whose real exit code is simply not available yet.
/// A running container has no terminal exit code (docker reports `0` for it),
/// so only a stopped container contributes one.
pub(crate) fn backend_exit_code(docker_state: Option<&DockerState>) -> Option<i32> {
    let state = docker_state?;
    if state.running {
        None
    } else {
        state.exit_code
    }
}

/// Reconcile the OOM observation from the stored record and from `docker inspect`.
///
/// `State.OOMKilled` is a container-cgroup flag: the kernel sets it when ANY
/// process in the cgroup is OOM-killed and it is never cleared for the life of
/// the container (moby/moby#47618). It is therefore an *observation*, never a
/// verdict about the session (issue #151) — a container that lost one child
/// process keeps running and can still exit `0`. Once observed, the flag stays
/// `true` for the record.
pub(crate) fn resolve_oom_observation(
    record: &ExecutionRecord,
    docker_state: Option<&DockerState>,
) -> Option<bool> {
    let inspected = docker_state.and_then(|state| state.oom_killed);
    if record.oom_killed == Some(true) || inspected == Some(true) {
        return Some(true);
    }
    if record.oom_killed == Some(false) || inspected == Some(false) {
        return Some(false);
    }
    None
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

/// Set `end_time` on a record that just became terminal, and record where the
/// timestamp came from (issue #170.2).
///
/// Precedence: the container's own `State.FinishedAt`, then the anchored
/// `Finished:` footer `start` wrote, and only then the time the end was
/// *observed* — which is marked as such instead of masquerading as a finish
/// time, the way an unconditional `Utc::now()` used to.
pub(crate) fn apply_end_time(
    record: &mut ExecutionRecord,
    docker_state: Option<&DockerState>,
    footer: &LogFooter,
) {
    if let Some(started_at) = docker_state.and_then(|state| state.started_at.clone()) {
        record.container_started_at = Some(started_at);
    }
    if record.end_time.is_some() {
        return;
    }
    if let Some(finished_at) = docker_state.and_then(|state| state.finished_at.clone()) {
        record.end_time = Some(finished_at);
        record.end_time_source = Some(END_TIME_SOURCE_DOCKER_FINISHED_AT.to_string());
        return;
    }
    if let Some(finished_at) = footer.finished_at.clone() {
        record.end_time = Some(finished_at);
        record.end_time_source = Some(END_TIME_SOURCE_LOG_FOOTER.to_string());
        return;
    }
    let now = Utc::now().to_rfc3339();
    record.end_time = Some(now.clone());
    record.end_time_source = Some(END_TIME_SOURCE_OBSERVED_AT.to_string());
    record.observed_at = Some(now);
}
