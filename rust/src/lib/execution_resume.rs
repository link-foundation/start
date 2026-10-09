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
    build_docker_runtime_args, docker_command, docker_networks,
    get_docker_container_cleanup_policy, start_detached_docker_completion_watcher_with,
    DockerWatcherOptions,
};
use crate::docker_resource_limits::{build_resource_limits_status_line, normalize_resource_limits};
use crate::execution_control::{CommandRunner, SystemCommandRunner};
use crate::execution_store::{ExecutionRecord, ExecutionStatus, ExecutionStore};
use crate::isolation::isolation_log::append_log_file;
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
    /// Resource limits the new container is started with (snapshot resumes
    /// only, issue #176): `docker commit` does not carry the HostConfig over.
    pub resource_limits: Vec<String>,
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
    /// Report attachment failures while keeping existing injectable hooks compatible.
    fn attach_watcher(&self, session_name: &str, record: &ExecutionRecord) -> Result<(), String> {
        self.start_watcher(session_name, record);
        Ok(())
    }

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
        let _ = self.attach_watcher(session_name, record);
    }

    fn attach_watcher(&self, session_name: &str, record: &ExecutionRecord) -> Result<(), String> {
        let log_path = (!record.log_path.is_empty()).then(|| PathBuf::from(&record.log_path));
        start_detached_docker_completion_watcher_with(
            session_name,
            get_docker_container_cleanup_policy(&build_launch_options(record)),
            log_path.as_ref(),
            // The resumed session gets the same record, so the watcher that
            // outlives this process finalizes it too (issue #170.1).
            Some(record.uuid.as_str()),
            &DockerWatcherOptions {
                since: record
                    .attempt
                    .as_ref()
                    .map(|attempt| attempt.started_at.clone()),
                attempt_number: record.attempt.as_ref().map(|attempt| attempt.number),
                recover_on_kill: keeps_kill_recovery(session_name, record),
            },
        )
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

/// `docker start` re-runs the launch-time selector, so a container resumed in
/// place or relaunched through isolation keeps its kill recovery (issue #176);
/// a snapshot-derived container has no selector.
pub fn keeps_kill_recovery(session_name: &str, record: &ExecutionRecord) -> bool {
    record.attempt.as_ref().is_none_or(|attempt| {
        matches!(
            attempt.mode.as_str(),
            "docker-start" | "automatic-recovery" | "relaunch"
        )
    }) && record_option(record, "sessionName") == Some(session_name)
        && record
            .options
            .get("onKillResume")
            .is_some_and(|value| value.as_u64().unwrap_or(0) > 0)
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
        // Limits captured from the container on an earlier resume (issue #176).
        resource_limits: normalize_resource_limits(record.options.get("resourceLimits")),
        cpu_penalty_config: record
            .options
            .get("cpuPenaltyConfig")
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
        on_kill_resume: record
            .options
            .get("onKillResume")
            .and_then(Value::as_u64)
            .map(|n| n as u32),
        recovery_command: record_option(record, "recoveryCommand").map(str::to_string),
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
        // The relaunched session keeps writing to this record, so its watcher
        // is the one that must mark it terminal (issue #170.1).
        execution_id: Some(record.uuid.clone()),
        defer_completion_watcher: true,
    }
}

/// Build the steps that start a snapshot-derived container.
///
/// `docker run` can only join one network, so a session that was launched on
/// several networks is rebuilt the same way `run_isolated` builds it: create
/// the container, connect the additional networks, then start it. Dropping to a
/// single `docker run` when there is nothing extra to connect keeps the common
/// case to one command.
fn build_snapshot_start_steps(
    docker: &str,
    container_args: Vec<String>,
    extra_networks: &[String],
    new_session_name: &str,
    snapshot_image: &str,
) -> Vec<ResumeStep> {
    if extra_networks.is_empty() {
        let mut args = vec!["run".to_string(), "-d".to_string()];
        args.extend(container_args);
        return vec![ResumeStep {
            command: docker.to_string(),
            args,
            description: format!("Run the new command in {}", new_session_name),
        }];
    }

    let mut create_args = vec!["create".to_string()];
    create_args.extend(container_args);
    let mut steps = vec![ResumeStep {
        command: docker.to_string(),
        args: create_args,
        description: format!("Create {} from {}", new_session_name, snapshot_image),
    }];
    for network in extra_networks {
        steps.push(ResumeStep {
            command: docker.to_string(),
            args: vec![
                "network".to_string(),
                "connect".to_string(),
                network.clone(),
                new_session_name.to_string(),
            ],
            description: format!("Connect {} to network {}", new_session_name, network),
        });
    }
    steps.push(ResumeStep {
        command: docker.to_string(),
        args: vec!["start".to_string(), new_session_name.to_string()],
        description: format!("Run the new command in {}", new_session_name),
    });
    steps
}

fn docker_snapshot_plan(
    record: &ExecutionRecord,
    backend: &str,
    session_name: &str,
    command: &str,
    attempt: u64,
    live_resource_limits: Option<Vec<String>>,
) -> ResumePlan {
    let snapshot_image = build_snapshot_image_name(session_name, attempt);
    let new_session_name = build_resumed_session_name(session_name, attempt);
    let docker = docker_command().to_string_lossy().to_string();

    let mut launch_options = build_launch_options(record);
    // `docker commit` keeps the filesystem but not the HostConfig, so the
    // limits must be passed to the new container explicitly (issue #176).
    if let Some(limits) = live_resource_limits {
        launch_options.resource_limits = limits;
    }
    let mut container_args = vec!["--name".to_string(), new_session_name.clone()];
    if let Some(user) = record_option(record, "user") {
        container_args.push("--user".to_string());
        container_args.push(user.to_string());
    }
    container_args.extend(
        build_docker_runtime_args(&launch_options)
            .into_iter()
            .map(str::to_string),
    );
    container_args.push(snapshot_image.clone());
    container_args.push("sh".to_string());
    container_args.push("-c".to_string());
    container_args.push(command.to_string());

    let mut steps = vec![ResumeStep {
        command: docker.clone(),
        args: vec![
            "commit".to_string(),
            session_name.to_string(),
            snapshot_image.clone(),
        ],
        description: format!("Snapshot container {} as {}", session_name, snapshot_image),
    }];
    steps.extend(build_snapshot_start_steps(
        &docker,
        container_args,
        &docker_networks(&launch_options)
            .into_iter()
            .skip(1)
            .map(str::to_string)
            .collect::<Vec<_>>(),
        &new_session_name,
        &snapshot_image,
    ));

    ResumePlan {
        mode: ResumeMode::DockerSnapshot,
        backend: backend.to_string(),
        session_name: session_name.to_string(),
        new_session_name: Some(new_session_name.clone()),
        snapshot_image: Some(snapshot_image.clone()),
        command: command.to_string(),
        attempt,
        resource_limits: launch_options.resource_limits.clone(),
        steps,
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
    build_resume_plan_with_limits(record, new_command, probe, None)
}

/// [`build_resume_plan`] with the resource limits read from the stopped
/// container with `docker inspect`; falls back to the stored ones when `None`.
pub fn build_resume_plan_with_limits(
    record: &ExecutionRecord,
    new_command: Option<&str>,
    probe: &SessionProbe,
    live_resource_limits: Option<Vec<String>>,
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
                resource_limits: Vec::new(),
                steps: vec![ResumeStep {
                    command: docker_command().to_string_lossy().to_string(),
                    args: vec!["start".to_string(), session_name.clone()],
                    description: format!("Start stopped container {}", session_name),
                }],
                launch_options: None,
                message: format!("Resumed detached docker container: {}", session_name),
                session_name,
            },
            Some(new_command) => docker_snapshot_plan(
                record,
                &backend,
                &session_name,
                new_command,
                attempt,
                live_resource_limits,
            ),
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
        resource_limits: Vec::new(),
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
    /// Limits the snapshot-derived container was started with (issue #176).
    pub resource_limits: &'a [String],
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
    if !result.resource_limits.is_empty() {
        lines.push(format!(
            "  resourceLimits {}",
            escape_for_links_notation(&result.resource_limits.join(" "))
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
                "resourceLimits": (!result.resource_limits.is_empty())
                    .then_some(result.resource_limits),
                "command": result.command,
                "message": result.message,
            });
            if let Value::Object(ref mut map) = value {
                map.retain(|_, entry| !entry.is_null());
            }
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
        }
        Some("text") => {
            let mut lines = vec![
                format!("Resume Mode:   {}", result.mode.as_str()),
                format!("UUID:          {}", result.uuid),
                format!("Backend:       {}", result.backend),
                format!("Session Name:  {}", result.session_name),
                format!("Command:       {}", result.command),
            ];
            if !result.resource_limits.is_empty() {
                lines.push(format!(
                    "Resource Limits: {}",
                    result.resource_limits.join(" ")
                ));
            }
            lines.push(result.message.to_string());
            lines.join("\n")
        }
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
    let attempt = crate::execution_attempt::create_attempt(
        record,
        plan.mode.as_str(),
        active_session_name(plan),
    );
    crate::execution_attempt::archive_attempt(record);
    record.attempt = Some(attempt);
    record
        .options
        .insert("resumeCount".to_string(), json!(plan.attempt));
    record.options.insert(
        "resumedAt".to_string(),
        json!(record.attempt.as_ref().unwrap().started_at),
    );
    // A resume is a new deliberate start: launch-time recovery applies again.
    record.options.remove("stopRequestedAt");
    record.options.remove("exitEvidence");
    if !plan.resource_limits.is_empty() {
        record
            .options
            .insert("resourceLimits".to_string(), json!(plan.resource_limits));
    }

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

#[path = "execution_resume_flow.rs"]
mod resume_flow;
pub use resume_flow::{
    resume_execution, resume_execution_with, resume_execution_with_options,
    resume_execution_with_resources,
};
