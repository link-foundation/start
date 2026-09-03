//! Resume tracked detached executions (issue #162).
//!
//! `--resume <id>` restarts a stored execution, and `--resume <id> -- <command>`
//! runs a *different* command against the same container filesystem. Both keep
//! the original execution UUID so `--status`, `--list` and `--upload-log` keep
//! addressing one logical session across restarts.
//!
//! Three strategies, chosen from the probed session state:
//! - `DockerStart`: the container still exists and the stored command is re-run
//!   by `docker start` (its original entrypoint).
//! - `DockerSnapshot`: the container still exists but a new command was given,
//!   so its filesystem is committed to an image and a derived container runs
//!   the new command. This avoids `docker start -ai`, which would re-run the
//!   original entrypoint from scratch.
//! - `Relaunch`: nothing is left of the session, so the command is launched
//!   again through the stored isolation options.

use std::path::PathBuf;

use chrono::Utc;
use serde_json::{json, Value};

use crate::docker_cleanup::{
    build_docker_runtime_args, docker_command, get_docker_container_cleanup_policy,
    start_detached_docker_completion_watcher,
};
use crate::execution_control::{CommandRunner, SystemCommandRunner};
use crate::execution_store::{ExecutionRecord, ExecutionStatus, ExecutionStore};
use crate::isolation::{run_isolated, IsolationOptions, IsolationResult};
use crate::output_blocks::escape_for_links_notation;
use crate::session_probe::{probe_session, SessionProbe, SessionState};

/// Strategies `build_resume_plan` can pick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeMode {
    DockerStart,
    DockerSnapshot,
    Relaunch,
}

impl ResumeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ResumeMode::DockerStart => "docker-start",
            ResumeMode::DockerSnapshot => "docker-snapshot",
            ResumeMode::Relaunch => "relaunch",
        }
    }
}

/// One command run while carrying out a resume plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeStep {
    pub command: String,
    pub args: Vec<String>,
    pub description: String,
}

/// How a stored execution will be resumed.
#[derive(Debug, Clone)]
pub struct ResumePlan {
    pub mode: ResumeMode,
    pub backend: String,
    pub session_name: String,
    /// Set only when a snapshot-derived container replaces the original one.
    pub new_session_name: Option<String>,
    pub snapshot_image: Option<String>,
    pub command: String,
    pub attempt: u64,
    pub steps: Vec<ResumeStep>,
    pub launch_options: Option<IsolationOptions>,
    pub message: String,
}

/// Result of `resume_execution`.
pub struct ExecutionResumeResult {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}

/// Side effects a resume performs beyond running plan steps.
///
/// Injectable so tests can exercise the full resume flow without spawning a
/// completion watcher, launching an isolation backend, or reading log files.
pub trait ResumeHooks {
    /// Attach a fresh completion watcher to a resumed docker session.
    fn start_watcher(&self, session_name: &str, record: &ExecutionRecord);

    /// Launch the command again through its isolation backend.
    fn relaunch(&self, backend: &str, command: &str, options: &IsolationOptions)
        -> IsolationResult;

    /// Resolve the terminal result of a session that ended unsupervised.
    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord;
}

/// The real side effects: docker watcher, isolation backends, log evidence.
#[derive(Debug, Default)]
pub struct SystemResumeHooks;

impl ResumeHooks for SystemResumeHooks {
    fn start_watcher(&self, session_name: &str, record: &ExecutionRecord) {
        let log_path = (!record.log_path.is_empty()).then(|| PathBuf::from(&record.log_path));
        start_detached_docker_completion_watcher(
            session_name,
            get_docker_container_cleanup_policy(&build_launch_options(record)),
            log_path.as_ref(),
        );
    }

    fn relaunch(
        &self,
        backend: &str,
        command: &str,
        options: &IsolationOptions,
    ) -> IsolationResult {
        run_isolated(backend, command, options)
    }

    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        crate::status_formatter::enrich_detached_status(record)
    }
}

fn record_option<'a>(record: &'a ExecutionRecord, key: &str) -> Option<&'a str> {
    record.options.get(key).and_then(|value| value.as_str())
}

fn record_flag(record: &ExecutionRecord, key: &str) -> bool {
    record
        .options
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn record_strings(record: &ExecutionRecord, key: &str) -> Vec<String> {
    record
        .options
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Build the docker image name used to snapshot a container before running a
/// new command in it. Docker repository names must be lowercase and limited to
/// `[a-z0-9._-]`, so session names are sanitized.
pub fn build_snapshot_image_name(session_name: &str, attempt: u64) -> String {
    let mut sanitized = String::new();
    let mut pending_dash = false;
    for ch in session_name.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' || ch == '_' || ch == '-' {
            if pending_dash {
                sanitized.push('-');
                pending_dash = false;
            }
            sanitized.push(ch);
        } else if !sanitized.is_empty() || !pending_dash {
            pending_dash = true;
        }
    }
    if pending_dash {
        sanitized.push('-');
    }
    let sanitized = sanitized.trim_start_matches(['-', '.']).to_string();
    let sanitized = if sanitized.is_empty() {
        "session".to_string()
    } else {
        sanitized
    };
    format!("start-command-resume/{}:{}", sanitized, attempt)
}

/// Build the container name for a snapshot-based resume.
pub fn build_resumed_session_name(session_name: &str, attempt: u64) -> String {
    format!("{}-resume-{}", session_name, attempt)
}

/// Rebuild the isolation options stored on a record so the command can be
/// launched again with the same configuration.
pub fn build_launch_options(record: &ExecutionRecord) -> IsolationOptions {
    let networks = record_strings(record, "networks");
    IsolationOptions {
        session: record_option(record, "sessionName").map(str::to_string),
        image: record_option(record, "image").map(str::to_string),
        volumes: record_strings(record, "volumes"),
        mounts: record_strings(record, "mounts"),
        env: record_strings(record, "env"),
        privileged: record_flag(record, "privileged"),
        network: networks.first().cloned(),
        networks,
        network_aliases: record_strings(record, "networkAliases"),
        endpoint: record_option(record, "endpoint").map(str::to_string),
        detached: true,
        user: record_option(record, "user").map(str::to_string),
        keep_alive: record_flag(record, "keepAlive"),
        auto_remove_docker_container: record_flag(record, "autoRemoveDockerContainer"),
        always_cleanup_container: record_flag(record, "alwaysCleanupContainer"),
        keep_container: record_flag(record, "keepContainer"),
        keep_container_on_fail: record_flag(record, "keepContainerOnFail"),
        shell: record_option(record, "shell").unwrap_or("auto").to_string(),
        // Append to the same log so one logical session keeps one gap-free record.
        log_path: (!record.log_path.is_empty()).then(|| PathBuf::from(&record.log_path)),
    }
}

fn docker_snapshot_plan(
    record: &ExecutionRecord,
    backend: &str,
    session_name: &str,
    command: &str,
    attempt: u64,
) -> ResumePlan {
    let snapshot_image = build_snapshot_image_name(session_name, attempt);
    let new_session_name = build_resumed_session_name(session_name, attempt);
    let docker = docker_command().to_string_lossy().to_string();

    let launch_options = build_launch_options(record);
    let mut run_args = vec![
        "run".to_string(),
        "-d".to_string(),
        "--name".to_string(),
        new_session_name.clone(),
    ];
    if let Some(user) = record_option(record, "user") {
        run_args.push("--user".to_string());
        run_args.push(user.to_string());
    }
    run_args.extend(
        build_docker_runtime_args(&launch_options)
            .into_iter()
            .map(str::to_string),
    );
    run_args.push(snapshot_image.clone());
    run_args.push("sh".to_string());
    run_args.push("-c".to_string());
    run_args.push(command.to_string());

    ResumePlan {
        mode: ResumeMode::DockerSnapshot,
        backend: backend.to_string(),
        session_name: session_name.to_string(),
        new_session_name: Some(new_session_name.clone()),
        snapshot_image: Some(snapshot_image.clone()),
        command: command.to_string(),
        attempt,
        steps: vec![
            ResumeStep {
                command: docker.clone(),
                args: vec![
                    "commit".to_string(),
                    session_name.to_string(),
                    snapshot_image.clone(),
                ],
                description: format!("Snapshot container {} as {}", session_name, snapshot_image),
            },
            ResumeStep {
                command: docker,
                args: run_args,
                description: format!("Run the new command in {}", new_session_name),
            },
        ],
        launch_options: None,
        message: format!(
            "Resumed session in new container {} from snapshot of {}",
            new_session_name, session_name
        ),
    }
}

/// Decide how a stored execution should be resumed.
pub fn build_resume_plan(
    record: &ExecutionRecord,
    new_command: Option<&str>,
    probe: &SessionProbe,
) -> Result<ResumePlan, String> {
    let session_name = record_option(record, "sessionName")
        .ok_or_else(|| "Execution record does not contain an isolation session name.".to_string())?
        .to_string();

    if record_option(record, "isolationMode") != Some("detached") {
        return Err("Only detached isolated executions can be resumed.".to_string());
    }

    if probe.alive {
        return Err(format!(
            "Session \"{}\" is still running. Use `$ --attach {}` to re-enter it, or `$ --stop {}` first.",
            session_name, record.uuid, record.uuid
        ));
    }

    let backend = record_option(record, "isolated")
        .unwrap_or("unknown")
        .to_string();
    let command = new_command.unwrap_or(record.command.as_str()).to_string();
    if command.is_empty() {
        return Err(format!(
            "Execution \"{}\" has no stored command to resume.",
            record.uuid
        ));
    }

    let attempt = record
        .options
        .get("resumeCount")
        .and_then(|value| value.as_u64())
        .unwrap_or(0)
        + 1;

    if backend == "docker" && probe.state == SessionState::Stopped {
        return Ok(match new_command {
            None => ResumePlan {
                mode: ResumeMode::DockerStart,
                backend,
                new_session_name: None,
                snapshot_image: None,
                command,
                attempt,
                steps: vec![ResumeStep {
                    command: docker_command().to_string_lossy().to_string(),
                    args: vec!["start".to_string(), session_name.clone()],
                    description: format!("Start stopped container {}", session_name),
                }],
                launch_options: None,
                message: format!("Resumed detached docker container: {}", session_name),
                session_name,
            },
            Some(new_command) => {
                docker_snapshot_plan(record, &backend, &session_name, new_command, attempt)
            }
        });
    }

    Ok(ResumePlan {
        mode: ResumeMode::Relaunch,
        message: format!("Relaunched {} session: {}", backend, session_name),
        backend,
        new_session_name: None,
        snapshot_image: None,
        command,
        attempt,
        steps: Vec::new(),
        launch_options: Some(build_launch_options(record)),
        session_name,
    })
}

/// Fields reported after a resume attempt.
pub struct ResumeResultFields<'a> {
    pub identifier: &'a str,
    pub uuid: &'a str,
    pub mode: ResumeMode,
    pub backend: &'a str,
    pub session_name: &'a str,
    pub previous_session_name: Option<&'a str>,
    pub snapshot_image: Option<&'a str>,
    pub command: &'a str,
    pub message: &'a str,
}

/// Format a resume result as links notation.
pub fn format_resume_result_as_links_notation(result: &ResumeResultFields) -> String {
    let mut lines = vec![
        "executionResume".to_string(),
        format!(
            "  identifier {}",
            escape_for_links_notation(result.identifier)
        ),
        format!("  uuid {}", escape_for_links_notation(result.uuid)),
        format!("  mode {}", escape_for_links_notation(result.mode.as_str())),
        format!("  backend {}", escape_for_links_notation(result.backend)),
        format!(
            "  sessionName {}",
            escape_for_links_notation(result.session_name)
        ),
    ];
    if let Some(previous) = result.previous_session_name {
        lines.push(format!(
            "  previousSessionName {}",
            escape_for_links_notation(previous)
        ));
    }
    if let Some(image) = result.snapshot_image {
        lines.push(format!(
            "  snapshotImage {}",
            escape_for_links_notation(image)
        ));
    }
    lines.push(format!(
        "  command {}",
        escape_for_links_notation(result.command)
    ));
    lines.push(format!(
        "  message {}",
        escape_for_links_notation(result.message)
    ));
    lines.join("\n")
}

/// Format a resume result in the requested output format.
pub fn format_resume_result(result: &ResumeResultFields, output_format: Option<&str>) -> String {
    match output_format {
        Some("json") => {
            let mut value = json!({
                "identifier": result.identifier,
                "uuid": result.uuid,
                "mode": result.mode.as_str(),
                "backend": result.backend,
                "sessionName": result.session_name,
                "previousSessionName": result.previous_session_name,
                "snapshotImage": result.snapshot_image,
                "command": result.command,
                "message": result.message,
            });
            if let Value::Object(ref mut map) = value {
                map.retain(|_, entry| !entry.is_null());
            }
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
        }
        Some("text") => [
            format!("Resume Mode:   {}", result.mode.as_str()),
            format!("UUID:          {}", result.uuid),
            format!("Backend:       {}", result.backend),
            format!("Session Name:  {}", result.session_name),
            format!("Command:       {}", result.command),
            result.message.to_string(),
        ]
        .join("\n"),
        _ => format_resume_result_as_links_notation(result),
    }
}

/// Apply the resume outcome to the stored record, keeping the original UUID so
/// one logical session stays addressable across restarts.
pub fn apply_resume_to_record(
    record: &mut ExecutionRecord,
    plan: &ResumePlan,
    container_id: Option<&str>,
) {
    record
        .options
        .insert("resumeCount".to_string(), json!(plan.attempt));
    record
        .options
        .insert("resumedAt".to_string(), json!(Utc::now().to_rfc3339()));

    if let Some(new_session_name) = &plan.new_session_name {
        let mut history = record
            .options
            .get("sessionNameHistory")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        if let Some(previous) = record.options.get("sessionName").cloned() {
            history.push(previous);
        }
        record
            .options
            .insert("sessionNameHistory".to_string(), Value::Array(history));
        record
            .options
            .insert("sessionName".to_string(), json!(new_session_name));
    }
    if let Some(snapshot_image) = &plan.snapshot_image {
        record
            .options
            .insert("image".to_string(), json!(snapshot_image));
    }
    if let Some(container_id) = container_id {
        record
            .options
            .insert("containerId".to_string(), json!(container_id));
    }

    record.command = plan.command.clone();
    record.status = ExecutionStatus::Executing;
    record.exit_code = None;
    record.end_time = None;
    record.exit_reason = None;
    record.oom_killed = None;
}

fn active_session_name(plan: &ResumePlan) -> &str {
    plan.new_session_name
        .as_deref()
        .unwrap_or(&plan.session_name)
}

/// Resume a tracked execution by UUID or session name.
pub fn resume_execution(
    store: Option<&ExecutionStore>,
    identifier: &str,
    command: Option<&str>,
    output_format: Option<&str>,
) -> ExecutionResumeResult {
    resume_execution_with(
        store,
        identifier,
        command,
        output_format,
        &SystemCommandRunner,
        &SystemResumeHooks,
    )
}

/// Resume with an injectable command runner and hooks, so tests never touch
/// docker.
pub fn resume_execution_with<R: CommandRunner, H: ResumeHooks>(
    store: Option<&ExecutionStore>,
    identifier: &str,
    command: Option<&str>,
    output_format: Option<&str>,
    runner: &R,
    hooks: &H,
) -> ExecutionResumeResult {
    let Some(store) = store else {
        return ExecutionResumeResult {
            success: false,
            output: None,
            error: Some("Execution tracking is disabled.".to_string()),
        };
    };

    let Some(mut record) = store.get(identifier) else {
        return ExecutionResumeResult {
            success: false,
            output: None,
            error: Some(format!(
                "No execution found with UUID or session name: {}",
                identifier
            )),
        };
    };

    let probe = probe_session(&record, runner);
    let plan = match build_resume_plan(&record, command, &probe) {
        Ok(plan) => plan,
        Err(error) => {
            return ExecutionResumeResult {
                success: false,
                output: None,
                error: Some(error),
            }
        }
    };

    let mut container_id: Option<String> = None;

    if plan.mode == ResumeMode::Relaunch {
        let launch_options = plan.launch_options.clone().unwrap_or_default();
        let launch_result = hooks.relaunch(&plan.backend, &plan.command, &launch_options);
        if !launch_result.success {
            return ExecutionResumeResult {
                success: false,
                output: None,
                error: Some(format!(
                    "Failed to relaunch {} session \"{}\": {}",
                    plan.backend, plan.session_name, launch_result.message
                )),
            };
        }
        container_id = launch_result.container_id;
    } else {
        for step in &plan.steps {
            let result = runner.run(&step.command, &step.args);
            if !result.success {
                let detail = if !result.stderr.trim().is_empty() {
                    result.stderr.trim().to_string()
                } else {
                    result.error.clone().unwrap_or_else(|| {
                        format!(
                            "exit code {}",
                            result
                                .status
                                .map(|code| code.to_string())
                                .unwrap_or_else(|| "unknown".to_string())
                        )
                    })
                };
                return ExecutionResumeResult {
                    success: false,
                    output: None,
                    error: Some(format!(
                        "Failed to resume {} session \"{}\": {}",
                        plan.backend, plan.session_name, detail
                    )),
                };
            }
            let stdout = result.stdout.trim().to_string();
            if !stdout.is_empty() {
                container_id = Some(stdout);
            }
        }

        // The completion watcher died with the previous run (or with the
        // supervisor), so a new one must follow the resumed container.
        hooks.start_watcher(active_session_name(&plan), &record);
    }

    let previous_session_name = plan
        .new_session_name
        .as_ref()
        .map(|_| plan.session_name.clone());
    apply_resume_to_record(&mut record, &plan, container_id.as_deref());
    if let Err(error) = store.save(&record) {
        return ExecutionResumeResult {
            success: false,
            output: None,
            error: Some(error),
        };
    }

    let session_name = record_option(&record, "sessionName")
        .unwrap_or(&plan.session_name)
        .to_string();

    ExecutionResumeResult {
        success: true,
        output: Some(format_resume_result(
            &ResumeResultFields {
                identifier,
                uuid: &record.uuid,
                mode: plan.mode,
                backend: &plan.backend,
                session_name: &session_name,
                previous_session_name: previous_session_name.as_deref(),
                snapshot_image: plan.snapshot_image.as_deref(),
                command: &plan.command,
                message: &plan.message,
            },
            output_format,
        )),
        error: None,
    }
}

#[cfg(test)]
#[path = "execution_resume_cases.rs"]
mod tests;
