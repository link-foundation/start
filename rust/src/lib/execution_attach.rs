//! Attach to a tracked detached execution (issue #162).
//!
//! `--stop`/`--terminate` can already address a stored session name;
//! `--attach` completes the set by re-entering the session's terminal instead
//! of only tailing its log. `--attach --read-only` follows the output without
//! forwarding stdin, which is the safe default for supervisors that must not
//! accidentally type into a long-running agent session.

use std::process::{Command, Stdio};

use crate::docker_cleanup::docker_command;
use crate::execution_control::{CommandRunner, SystemCommandRunner};
use crate::execution_store::{ExecutionRecord, ExecutionStore};
use crate::output_blocks::escape_for_links_notation;
use crate::session_probe::{probe_session, SessionProbe, SessionState};

/// A resolved way back into a running session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachPlan {
    pub backend: String,
    pub session_name: String,
    pub command: String,
    pub args: Vec<String>,
    /// Whether stdin is forwarded to the session.
    pub interactive: bool,
    pub method: String,
    pub message: String,
}

/// Outcome of running an attach plan.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InteractiveRunOutput {
    pub success: bool,
    pub status: Option<i32>,
    pub error: Option<String>,
}

/// Runs an attach plan with the parent terminal wired up. Injectable so tests
/// never spawn a real `docker attach`.
pub trait InteractiveRunner {
    fn run(&self, plan: &AttachPlan) -> InteractiveRunOutput;
}

/// Runs the plan as a child process sharing this process' terminal.
#[derive(Debug, Default)]
pub struct SystemInteractiveRunner;

impl InteractiveRunner for SystemInteractiveRunner {
    fn run(&self, plan: &AttachPlan) -> InteractiveRunOutput {
        let mut command = Command::new(&plan.command);
        command
            .args(&plan.args)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .stdin(if plan.interactive {
                Stdio::inherit()
            } else {
                Stdio::null()
            });
        match command.status() {
            Ok(status) => InteractiveRunOutput {
                success: status.success(),
                status: status.code(),
                error: None,
            },
            Err(err) => InteractiveRunOutput {
                success: false,
                status: None,
                error: Some(err.to_string()),
            },
        }
    }
}

/// Result of `attach_execution`.
pub struct ExecutionAttachResult {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
}

fn record_option<'a>(record: &'a ExecutionRecord, key: &str) -> Option<&'a str> {
    record.options.get(key).and_then(|value| value.as_str())
}

fn log_follow_plan(
    record: &ExecutionRecord,
    backend: &str,
    session_name: &str,
) -> Result<AttachPlan, String> {
    if record.log_path.is_empty() {
        return Err(format!(
            "Execution \"{}\" has no stored log to follow.",
            record.uuid
        ));
    }
    Ok(AttachPlan {
        backend: backend.to_string(),
        session_name: session_name.to_string(),
        command: "tail".to_string(),
        args: vec!["-f".to_string(), record.log_path.clone()],
        interactive: false,
        method: "LOG_FOLLOW".to_string(),
        message: format!(
            "Following stored log for {} session: {}",
            backend, session_name
        ),
    })
}

fn not_running_error(record: &ExecutionRecord, probe: &SessionProbe, session_name: &str) -> String {
    if probe.state == SessionState::Missing {
        return format!(
            "Session \"{}\" no longer exists, so there is nothing to attach to. \
Use `$ --resume {}` to start it again, or `$ --status {}` to inspect the recorded result.",
            session_name, record.uuid, record.uuid
        );
    }
    let state = probe
        .container_status
        .clone()
        .unwrap_or_else(|| probe.state.as_str().to_string());
    format!(
        "Session \"{}\" is not running (state: {}). \
Use `$ --resume {}` to continue it in the same container, or `$ --status {}` to inspect the recorded result.",
        session_name, state, record.uuid, record.uuid
    )
}

/// Build the attach plan for an execution record.
pub fn build_attach_plan(
    record: &ExecutionRecord,
    read_only: bool,
    probe: &SessionProbe,
) -> Result<AttachPlan, String> {
    let session_name = record_option(record, "sessionName")
        .ok_or_else(|| "Execution record does not contain an isolation session name.".to_string())?
        .to_string();

    if record_option(record, "isolationMode") != Some("detached") {
        return Err("Only detached isolated executions can be attached to.".to_string());
    }

    let backend = record_option(record, "isolated")
        .unwrap_or("unknown")
        .to_string();

    // ssh sessions cannot be probed or re-entered locally: the stored log is
    // the only channel back into them.
    if backend == "ssh" {
        return log_follow_plan(record, &backend, &session_name);
    }

    if !probe.alive {
        return Err(not_running_error(record, probe, &session_name));
    }

    let docker = docker_command().to_string_lossy().to_string();

    match backend.as_str() {
        "screen" if read_only => log_follow_plan(record, &backend, &session_name),
        "screen" => Ok(AttachPlan {
            backend,
            command: "screen".to_string(),
            args: vec!["-r".to_string(), session_name.clone()],
            interactive: true,
            method: "SCREEN_ATTACH".to_string(),
            message: format!("Attaching to detached screen session: {}", session_name),
            session_name,
        }),
        "tmux" => Ok(AttachPlan {
            backend,
            args: if read_only {
                vec![
                    "attach-session".to_string(),
                    "-r".to_string(),
                    "-t".to_string(),
                    session_name.clone(),
                ]
            } else {
                vec![
                    "attach-session".to_string(),
                    "-t".to_string(),
                    session_name.clone(),
                ]
            },
            command: "tmux".to_string(),
            interactive: true,
            method: if read_only {
                "TMUX_ATTACH_READONLY".to_string()
            } else {
                "TMUX_ATTACH".to_string()
            },
            message: format!(
                "Attaching to detached tmux session: {}{}",
                session_name,
                if read_only { " (read-only)" } else { "" }
            ),
            session_name,
        }),
        "docker" if read_only => Ok(AttachPlan {
            backend,
            command: docker,
            args: vec!["logs".to_string(), "-f".to_string(), session_name.clone()],
            interactive: false,
            method: "DOCKER_LOG_FOLLOW".to_string(),
            message: format!(
                "Following logs of detached docker container: {}",
                session_name
            ),
            session_name,
        }),
        "docker" => Ok(AttachPlan {
            backend,
            command: docker,
            args: vec!["attach".to_string(), session_name.clone()],
            interactive: true,
            method: "DOCKER_ATTACH".to_string(),
            message: format!("Attaching to detached docker container: {}", session_name),
            session_name,
        }),
        other => Err(format!(
            "Attaching to detached {} executions is not supported.",
            other
        )),
    }
}

/// Fields reported after an attach attempt.
pub struct AttachResultFields<'a> {
    pub identifier: &'a str,
    pub uuid: &'a str,
    pub backend: &'a str,
    pub session_name: &'a str,
    pub method: &'a str,
    pub read_only: bool,
    pub command: &'a str,
    pub message: &'a str,
}

/// Format an attach result as links notation.
pub fn format_attach_result_as_links_notation(result: &AttachResultFields) -> String {
    [
        "executionAttach".to_string(),
        format!(
            "  identifier {}",
            escape_for_links_notation(result.identifier)
        ),
        format!("  uuid {}", escape_for_links_notation(result.uuid)),
        format!("  backend {}", escape_for_links_notation(result.backend)),
        format!(
            "  sessionName {}",
            escape_for_links_notation(result.session_name)
        ),
        format!("  method {}", escape_for_links_notation(result.method)),
        format!("  readOnly {}", result.read_only),
        format!("  command {}", escape_for_links_notation(result.command)),
        format!("  message {}", escape_for_links_notation(result.message)),
    ]
    .join("\n")
}

/// Attach to a tracked execution by UUID or session name.
pub fn attach_execution(
    store: Option<&ExecutionStore>,
    identifier: &str,
    read_only: bool,
) -> ExecutionAttachResult {
    attach_execution_with_runners(
        store,
        identifier,
        read_only,
        &SystemCommandRunner,
        &SystemInteractiveRunner,
    )
}

/// Attach with injectable runners, so tests never touch a real session.
pub fn attach_execution_with_runners<R: CommandRunner, I: InteractiveRunner>(
    store: Option<&ExecutionStore>,
    identifier: &str,
    read_only: bool,
    runner: &R,
    interactive_runner: &I,
) -> ExecutionAttachResult {
    let Some(store) = store else {
        return ExecutionAttachResult {
            success: false,
            output: None,
            error: Some("Execution tracking is disabled.".to_string()),
            exit_code: None,
        };
    };

    let Some(record) = store.get(identifier) else {
        return ExecutionAttachResult {
            success: false,
            output: None,
            error: Some(format!(
                "No execution found with UUID or session name: {}",
                identifier
            )),
            exit_code: None,
        };
    };

    let probe = probe_session(&record, runner);
    let plan = match build_attach_plan(&record, read_only, &probe) {
        Ok(plan) => plan,
        Err(error) => {
            return ExecutionAttachResult {
                success: false,
                output: None,
                error: Some(error),
                exit_code: None,
            }
        }
    };

    let command_line = std::iter::once(plan.command.clone())
        .chain(plan.args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let run_result = interactive_runner.run(&plan);

    if !run_result.success {
        let detail = run_result.error.clone().unwrap_or_else(|| {
            format!(
                "exit code {}",
                run_result
                    .status
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".to_string())
            )
        });
        return ExecutionAttachResult {
            success: false,
            output: None,
            error: Some(format!(
                "Failed to attach to {} session \"{}\": {}",
                plan.backend, plan.session_name, detail
            )),
            exit_code: Some(run_result.status.unwrap_or(1)),
        };
    }

    ExecutionAttachResult {
        success: true,
        output: Some(format_attach_result_as_links_notation(
            &AttachResultFields {
                identifier,
                uuid: &record.uuid,
                backend: &plan.backend,
                session_name: &plan.session_name,
                method: &plan.method,
                read_only,
                command: &command_line,
                message: &plan.message,
            },
        )),
        error: None,
        exit_code: None,
    }
}

#[cfg(test)]
#[path = "execution_attach_cases.rs"]
mod tests;
