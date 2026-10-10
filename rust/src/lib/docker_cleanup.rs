use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::cgroup_memory::{
    build_cgroup_memory_log_snippet, build_cgroup_sampler_start_snippet,
    build_cgroup_sampler_stop_snippet,
};
use crate::detached_finalize::build_detached_finalize_snippet_with_attempt;
use crate::docker_post_mortem::{
    build_docker_post_mortem_snippet, build_docker_removal_note_snippet,
    build_docker_state_snippet, build_docker_still_running_note_snippet,
    build_docker_wait_for_exit_snippet, format_container_post_mortem,
    format_container_removal_note, normalize_docker_timestamp, shell_vars, ContainerPostMortem,
    DOCKER_STATE_INSPECT_FORMAT,
};
use crate::exit_reason::{is_oom_kill_of_command, resolve_memory_exhaustion};
use crate::isolation::isolation_log::{
    append_log_file, create_shell_log_footer_snippet, read_log_tail, shell_quote,
    FATAL_MARKER_TAIL_BYTES,
};
use crate::isolation::IsolationOptions;

/// Exit codes a runtime produces when it aborts itself (SIGABRT / SIGSEGV).
/// Node/V8 prints `FATAL ERROR: Reached heap limit ...` and aborts long before
/// the container limit is reached, so the kernel never OOM-kills anything and
/// `State.OOMKilled` stays `false` (issue #165).
const SELF_ABORT_EXIT_CODES: [i32; 2] = [134, 139];

/// Appended to the kept-container reason for a self-abort exit code, so the
/// footer stops asserting the opposite of the `FATAL ERROR` printed a few lines
/// above it. The footer is the string downstream tooling greps.
const OOM_FLAG_BLIND_NOTE: &str = "a runtime self-abort on its own memory limit is invisible to this flag - check the log above for a fatal memory marker";

/// Shell fragment computing `$__start_command_reason` for the kept footer.
pub(crate) fn build_docker_kept_reason_snippet() -> String {
    let codes: Vec<String> = SELF_ABORT_EXIT_CODES
        .iter()
        .map(|code| code.to_string())
        .collect();
    format!(
        "__start_command_reason=\"exitCode=$__start_command_exit oomKilled=$__start_command_oom\"; case \"$__start_command_exit\" in {}) [ \"$__start_command_oom\" = true ] || __start_command_reason=\"$__start_command_reason ({})\";; esac",
        codes.join("|"),
        OOM_FLAG_BLIND_NOTE
    )
}

/// Build the extra `docker run` arguments contributed by runtime options
/// (--privileged, --env/-e, --volume/-v, --mount, --network,
/// --network-alias, resource limits). Returned references borrow
/// from `options`, which outlives the `docker run` invocation.
pub fn build_docker_runtime_args(options: &IsolationOptions) -> Vec<&str> {
    let mut args: Vec<&str> = Vec::new();
    if options.privileged {
        args.push("--privileged");
    }
    for env_var in &options.env {
        args.push("-e");
        args.push(env_var);
    }
    for label in &options.labels {
        args.push("--label");
        args.push(label);
    }
    for volume in &options.volumes {
        args.push("-v");
        args.push(volume);
    }
    for mount in &options.mounts {
        args.push("--mount");
        args.push(mount);
    }
    if let Some(network) = docker_networks(options).first() {
        args.push("--network");
        args.push(network);
    }
    for alias in &options.network_aliases {
        args.push("--network-alias");
        args.push(alias);
    }
    // Already in `--flag=value` form (issue #176).
    args.extend(options.resource_limits.iter().map(String::as_str));
    args
}

pub(crate) fn docker_networks(options: &IsolationOptions) -> Vec<&str> {
    if options.networks.is_empty() {
        options.network.iter().map(String::as_str).collect()
    } else {
        options.networks.iter().map(String::as_str).collect()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DockerContainerCleanupPolicy {
    Default,
    Always,
    Keep,
    KeepOnFail,
}

pub fn docker_command() -> std::ffi::OsString {
    std::env::var_os("START_DOCKER_BIN").unwrap_or_else(|| std::ffi::OsString::from("docker"))
}

pub(crate) fn get_docker_container_cleanup_policy(
    options: &IsolationOptions,
) -> DockerContainerCleanupPolicy {
    if options.keep_container {
        DockerContainerCleanupPolicy::Keep
    } else if options.keep_container_on_fail {
        DockerContainerCleanupPolicy::KeepOnFail
    } else if options.always_cleanup_container || options.auto_remove_docker_container {
        DockerContainerCleanupPolicy::Always
    } else {
        DockerContainerCleanupPolicy::Default
    }
}

pub(crate) fn is_abnormal_docker_exit(exit_code: i32, oom_killed: bool) -> bool {
    exit_code != 0 || oom_killed
}

pub(crate) fn should_cleanup_docker_container(
    policy: DockerContainerCleanupPolicy,
    exit_code: i32,
    oom_killed: bool,
) -> bool {
    match policy {
        DockerContainerCleanupPolicy::Default => !is_abnormal_docker_exit(exit_code, oom_killed),
        DockerContainerCleanupPolicy::Always => true,
        DockerContainerCleanupPolicy::Keep => false,
        DockerContainerCleanupPolicy::KeepOnFail => !is_abnormal_docker_exit(exit_code, oom_killed),
    }
}

pub(crate) fn docker_container_cleanup_instructions(container_name: &str) -> String {
    format!(
        "Container kept for investigation: {}\nRe-enter while running: $ --attach {}\nContinue the stored command: $ --resume {}\nRun another command (legacy containers snapshot the filesystem into a new container): $ --resume {} -- <command>\nRemove when done: docker rm -f {}",
        container_name, container_name, container_name, container_name, container_name
    )
}

pub(crate) fn append_docker_container_cleanup_policy_message(
    message: &mut String,
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
) {
    match policy {
        DockerContainerCleanupPolicy::Always => {
            message.push_str("\nContainer will be removed after command completes.");
        }
        DockerContainerCleanupPolicy::Default => {
            message.push_str("\nContainer will be removed after successful completion.");
            message.push_str(
                "\nContainer will be kept if the command fails or Docker reports OOMKilled.",
            );
            message.push_str(&format!(
                "\nRemove when done: docker rm -f {}",
                container_name
            ));
        }
        DockerContainerCleanupPolicy::Keep => {
            message.push('\n');
            message.push_str(&docker_container_cleanup_instructions(container_name));
        }
        DockerContainerCleanupPolicy::KeepOnFail => {
            message.push_str("\nContainer will be removed after successful completion.");
            message.push_str(
                "\nContainer will be kept if the command fails or Docker reports OOMKilled.",
            );
            message.push_str(&format!(
                "\nRemove when done: docker rm -f {}",
                container_name
            ));
        }
    }
}

/// Read a finished container's post-mortem facts in a single `docker inspect`.
///
/// The attached path only ever inspected `State.OOMKilled`, which left its
/// "Container kept for investigation" message unable to say *why* the container
/// died — the same gap the detached watcher had (issue #171.1). Reading the
/// facts once, before any `docker rm`, also makes them available to the removal
/// path, where the container is about to stop existing (issue #171.3).
pub(crate) fn read_docker_container_state(container_name: &str) -> Option<ContainerPostMortem> {
    let inspect = |format: &str| -> Option<String> {
        let output = Command::new(docker_command())
            .args(["inspect", "-f", format, container_name])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let state = inspect(DOCKER_STATE_INSPECT_FORMAT)?;
    // `State.Error` is free-form text that may contain spaces, so it cannot
    // ride along in the whitespace-separated template above.
    let error = inspect("{{.State.Error}}");
    Some(parse_docker_container_state(
        container_name,
        &state,
        error.as_deref(),
    ))
}

/// Turn the raw output of [`DOCKER_STATE_INSPECT_FORMAT`] into facts.
///
/// Split from the `docker inspect` call so the mapping — including the
/// rejection of docker's zero time — is testable without a docker daemon or a
/// process-wide `START_DOCKER_BIN` override.
pub(crate) fn parse_docker_container_state(
    container_name: &str,
    state: &str,
    error: Option<&str>,
) -> ContainerPostMortem {
    let mut parts = state.split_whitespace();
    let exit_code = parts.next().and_then(|value| value.parse::<i32>().ok());
    let oom_killed = match parts.next() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let started_at = normalize_docker_timestamp(parts.next());
    let finished_at = normalize_docker_timestamp(parts.next());
    ContainerPostMortem {
        container_name: container_name.to_string(),
        exit_code,
        oom_killed,
        started_at,
        finished_at,
        error: error
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
    }
}

/// Write the post-mortem for an attached run into its log and return the same
/// text for the console message.
///
/// Kept and removed containers both get their facts recorded — a kept container
/// gets the full block, a removed one the single line — so the log of an
/// attached run carries exactly what the detached watcher writes (issues
/// #171.2 and #171.3).
pub(crate) fn record_attached_docker_post_mortem(
    facts: Option<&ContainerPostMortem>,
    log_path: Option<&PathBuf>,
    removed: bool,
) -> String {
    let Some(facts) = facts else {
        return String::new();
    };
    let text = if removed {
        format_container_removal_note(facts)
    } else {
        format_container_post_mortem(facts)
    };
    if let Some(path) = log_path {
        append_log_file(path, &format!("\n{}", text));
    }
    format!("\n{}", text.trim_end())
}

pub(crate) fn read_docker_container_status(container_name: &str) -> Option<String> {
    let output = Command::new(docker_command())
        .args(["inspect", "-f", "{{.State.Status}}", container_name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if status.is_empty() {
        None
    } else {
        Some(status)
    }
}

/// Why an attached container was kept. The OOM flag is container-wide (#180):
/// a child OOM-killed under a command that exited on its own is not the
/// command being OOM-killed.
pub(crate) fn attached_docker_kept_reason(exit_code: i32, oom_killed: bool) -> &'static str {
    if !oom_killed {
        "\nContainer kept because the command failed."
    } else if is_oom_kill_of_command(Some(exit_code), Some(true), None) {
        "\nContainer kept because Docker reports it was OOM-killed."
    } else {
        "\nContainer kept because Docker reports a process in it was OOM-killed."
    }
}

pub(crate) fn append_attached_docker_cleanup_message(
    message: &mut String,
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
    exit_code: i32,
    log_path: Option<&PathBuf>,
    container_existed_before_launch: bool,
) {
    let state = read_docker_container_state(container_name);
    let oom_killed = state
        .as_ref()
        .and_then(|facts| facts.oom_killed)
        .unwrap_or(false);
    let post_mortem =
        |removed: bool| record_attached_docker_post_mortem(state.as_ref(), log_path, removed);
    if !container_existed_before_launch
        && read_docker_container_status(container_name).as_deref() == Some("created")
    {
        if remove_docker_container(container_name, log_path) {
            message.push_str("\nContainer removed after launch failure.");
        } else {
            message.push_str("\nWarning: failed to remove container after launch failure.");
        }
    } else if should_cleanup_docker_container(policy, exit_code, oom_killed) {
        if remove_docker_container(container_name, log_path) {
            message.push_str("\nContainer removed after completion.");
            message.push_str(&post_mortem(true));
        } else {
            message.push_str("\nWarning: failed to remove container automatically.");
            message.push_str(&format!(
                "\nRemove when done: docker rm -f {container_name}"
            ));
        }
    } else if policy == DockerContainerCleanupPolicy::Keep {
        message.push('\n');
        message.push_str(&docker_container_cleanup_instructions(container_name));
        message.push_str(&post_mortem(false));
    } else {
        let tail = log_path
            .and_then(|path| read_log_tail(&path.to_string_lossy(), FATAL_MARKER_TAIL_BYTES));
        if crate::exit_reason::resolve_exit_reason(
            Some(exit_code),
            tail.as_deref(),
            Some(oom_killed),
            None,
        )
        .as_deref()
            == Some(crate::exit_reason::CGROUP_OOM_EXIT_REASON)
        {
            message.push_str("\nContainer kept because Docker reports it was OOM-killed.");
        } else {
            message.push_str(attached_docker_kept_reason(exit_code, oom_killed));
        }
        // A runtime that aborts on its own memory limit never trips the
        // container flag, so `oomKilled false` alone would contradict the
        // `FATAL ERROR` the runtime just printed into this very log (issue
        // #165). Best effort: the tail is read right after the child exits.
        if let Some(memory) =
            resolve_memory_exhaustion(Some(exit_code), tail.as_deref(), Some(oom_killed), None)
        {
            message.push_str(&format!(
                "\nMemory exhaustion detected in the log: {}",
                memory.memory_exhausted_reason
            ));
        }
        message.push_str(&format!(
            "\nRemove when done: docker rm -f {container_name}"
        ));
        message.push_str(&post_mortem(false));
    }
}

pub(crate) fn remove_docker_container(container_name: &str, log_path: Option<&PathBuf>) -> bool {
    let output = Command::new(docker_command())
        .args(["rm", "-f", container_name])
        .output();
    match output {
        Ok(output) => {
            if let Some(path) = log_path {
                let mut combined = String::new();
                combined.push_str(&String::from_utf8_lossy(&output.stdout));
                combined.push_str(&String::from_utf8_lossy(&output.stderr));
                if !combined.is_empty() {
                    let content = if combined.ends_with('\n') {
                        combined
                    } else {
                        format!("{}\n", combined)
                    };
                    append_log_file(path, &content);
                }
            }
            output.status.success()
        }
        Err(_) => false,
    }
}

fn build_docker_kept_log_snippet(container_name: &str, quoted_log_path: &str) -> String {
    let quoted_name = shell_quote(container_name);
    format!(
        "{}; printf '\\nContainer kept for investigation: %s\\nReason: %s\\nRe-enter while running: $ --attach %s\\nContinue the stored command: $ --resume %s\\nRun another command (legacy containers snapshot the filesystem into a new container): $ --resume %s -- <command>\\nRemove when done: docker rm -f %s\\n' {} \"$__start_command_reason\" {} {} {} {} >> {}",
        build_docker_kept_reason_snippet(),
        quoted_name, quoted_name, quoted_name, quoted_name, quoted_name, quoted_log_path
    )
}

fn successful_non_oom_condition() -> &'static str {
    "[ \"$__start_command_exit\" -eq 0 ] 2>/dev/null && [ \"$__start_command_oom\" != true ]"
}

/// Build the shell the detached completion watcher runs after the container is
/// gone.
///
/// Order matters. The post-mortem block and the removal note go in *before* the
/// footer, so the `Finished:`/`Exit Code:` pair stays the last thing in the log
/// (issue #171.2); the store is finalized *after* the footer, so a record only
/// becomes terminal once its log is complete (issue #170.1).
///
/// It only does any of that once the container has really exited: the return of
/// `docker logs -f` / `docker wait` is not proof of exit (issue #174). A
/// container that is somehow still running afterwards is never removed, gets no
/// `Exit Code:` footer and is never finalized — its record stays `executing`.
pub fn build_detached_docker_completion_script(
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
    log_path: Option<&PathBuf>,
    execution_id: Option<&str>,
) -> String {
    build_detached_docker_completion_script_with(
        container_name,
        policy,
        log_path,
        execution_id,
        &DockerWatcherOptions::default(),
    )
}

/// Extra behaviour of a detached completion watcher (issue #176).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DockerWatcherOptions {
    /// Limits `docker logs` to output after a restart, so a resumed run does
    /// not copy the previous run's output into the log again.
    pub since: Option<String>,
    pub attempt_number: Option<u64>,
    /// Hand a killed main process (exit 137, or `OOMKilled` without a usable
    /// exit code, issue #178) to the recovery entry point first. When it
    /// resumes the container, this watcher stops there — a new one follows
    /// the resumed run — and cleanup, footer and finalization are left to
    /// whichever watcher sees the last run end.
    pub recover_on_kill: bool,
}

/// [`build_detached_docker_completion_script`] with [`DockerWatcherOptions`].
pub fn build_detached_docker_completion_script_with(
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
    log_path: Option<&PathBuf>,
    execution_id: Option<&str>,
    watcher: &DockerWatcherOptions,
) -> String {
    let quoted_name = shell_quote(container_name);
    // The container's cgroup disappears with it, so its memory counters are
    // sampled while it runs (issue #182).
    let mut parts = vec![build_cgroup_sampler_start_snippet(container_name)];
    let cpu_start = crate::cpu_penalty_monitor::start_snippet(
        execution_id,
        container_name,
        watcher.attempt_number,
    );
    if !cpu_start.is_empty() {
        parts.push(cpu_start);
    }
    // Everything that assumes the container has exited: cleanup, footer and
    // finalization. Guarded as a whole by `.State.Running` below.
    let mut exited = Vec::new();
    let quoted_log_path = log_path.map(|path| shell_quote(&path.to_string_lossy()));

    if let Some(quoted_log_path) = quoted_log_path.as_deref() {
        let since = watcher
            .since
            .as_deref()
            .map(|since| format!(" --since {}", shell_quote(since)))
            .unwrap_or_default();
        if let Some(number) = watcher.attempt_number {
            let executable = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("start"));
            parts.push(format!(
                "docker logs -f --timestamps{} {} 2>&1 | {} {} {} {} {}",
                since,
                quoted_name,
                shell_quote(&executable.to_string_lossy()),
                crate::detached_output::INTERNAL_OUTPUT_FLAG,
                quoted_log_path,
                number,
                shell_quote(watcher.since.as_deref().unwrap_or(""))
            ));
        } else {
            parts.push(format!(
                "docker logs -f{} {} >> {} 2>&1",
                since, quoted_name, quoted_log_path
            ));
        }
        parts.push(build_docker_wait_for_exit_snippet(
            container_name,
            Some(quoted_log_path),
        ));
        parts.push(crate::cpu_penalty_monitor::stop_snippet());
        parts.push(build_cgroup_sampler_stop_snippet());
        parts.push(build_docker_state_snippet(container_name));
        parts.push(crate::exit_evidence::snippet(
            container_name,
            quoted_log_path,
        ));

        let memory = build_cgroup_memory_log_snippet(quoted_log_path);
        let (capture_image, remove_image) =
            crate::docker_snapshot_safety::snapshot_image_cleanup_snippets(
                container_name,
                &format!(">> {} 2>&1", quoted_log_path),
            );
        let remove = format!(
            "{}; if docker rm -f {} >> {} 2>&1; then {}; fi; {}; {}",
            capture_image,
            quoted_name,
            quoted_log_path,
            remove_image,
            build_docker_removal_note_snippet(container_name, quoted_log_path),
            memory
        );
        // A kept container is exactly the case the user will investigate, so it
        // gets the full post-mortem before the copy-paste instructions.
        let keep = format!(
            "{}; {}; {}",
            build_docker_post_mortem_snippet(container_name, quoted_log_path),
            memory,
            build_docker_kept_log_snippet(container_name, quoted_log_path)
        );
        match policy {
            DockerContainerCleanupPolicy::Always => exited.push(remove),
            DockerContainerCleanupPolicy::Default | DockerContainerCleanupPolicy::KeepOnFail => {
                exited.push(format!(
                    "if {}; then {}; else {}; fi",
                    successful_non_oom_condition(),
                    remove,
                    keep
                ))
            }
            // Previously wrote nothing at all: the container is always kept, so
            // the log said nothing about why it stopped (issue #171.2).
            DockerContainerCleanupPolicy::Keep => exited.push(keep),
        }
        exited.push(format!(
            "{} >> {}",
            create_shell_log_footer_snippet(),
            quoted_log_path
        ));
    } else {
        parts.push(format!("docker wait {} >/dev/null 2>&1", quoted_name));
        parts.push(build_docker_wait_for_exit_snippet(container_name, None));
        parts.push(crate::cpu_penalty_monitor::stop_snippet());
        parts.push(build_cgroup_sampler_stop_snippet());
        parts.push(build_docker_state_snippet(container_name));
        let (capture_image, remove_image) =
            crate::docker_snapshot_safety::snapshot_image_cleanup_snippets(
                container_name,
                ">/dev/null 2>&1",
            );
        match policy {
            DockerContainerCleanupPolicy::Always => exited.push(format!(
                "{}; if docker rm -f {} >/dev/null 2>&1; then {}; fi",
                capture_image, quoted_name, remove_image
            )),
            DockerContainerCleanupPolicy::Default | DockerContainerCleanupPolicy::KeepOnFail => {
                exited.push(format!(
                    "if {}; then {}; if docker rm -f {} >/dev/null 2>&1; then {}; fi; fi",
                    successful_non_oom_condition(),
                    capture_image,
                    quoted_name,
                    remove_image
                ))
            }
            DockerContainerCleanupPolicy::Keep => {}
        }
    }

    if let Some(execution_id) = execution_id {
        // Last, so the record is only marked terminal once the log is complete.
        exited.push(build_detached_finalize_snippet_with_attempt(
            execution_id,
            watcher.attempt_number,
        ));
    }

    let still_running = quoted_log_path
        .as_deref()
        .map(|log| build_docker_still_running_note_snippet(container_name, log))
        .unwrap_or_else(|| ":".to_string());
    let exited = if exited.is_empty() {
        ":".to_string()
    } else {
        exited.join("; ")
    };
    let recovery = match execution_id {
        Some(execution_id) if watcher.recover_on_kill => format!(
            "elif {}; then :; ",
            crate::execution_recovery::build_recovery_snippet(execution_id)
        ),
        _ => String::new(),
    };
    parts.push(format!(
        "if [ \"${}\" = true ]; then {}; {}else {}; fi",
        shell_vars::RUNNING,
        still_running,
        recovery,
        exited
    ));

    parts.join("; ")
}

pub(crate) fn start_detached_docker_completion_watcher_with(
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
    log_path: Option<&PathBuf>,
    execution_id: Option<&str>,
    watcher: &DockerWatcherOptions,
) -> Result<(), String> {
    let script = build_detached_docker_completion_script_with(
        container_name,
        policy,
        log_path,
        execution_id,
        watcher,
    );
    Command::new("sh")
        .args(["-c", &script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(crate) struct AttachedDockerChild {
    child: Child,
    stdout_thread: Option<thread::JoinHandle<()>>,
    stderr_thread: Option<thread::JoinHandle<()>>,
}

impl AttachedDockerChild {
    pub(crate) fn wait(mut self) -> std::io::Result<ExitStatus> {
        let status = self.child.wait();
        if let Some(handle) = self.stdout_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.stderr_thread.take() {
            let _ = handle.join();
        }
        status
    }
}

pub(crate) fn spawn_attached_docker(
    args: &[&str],
    log_path: Option<&PathBuf>,
) -> std::io::Result<AttachedDockerChild> {
    if log_path.is_none() {
        let child = Command::new(docker_command())
            .args(args)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()?;
        return Ok(AttachedDockerChild {
            child,
            stdout_thread: None,
            stderr_thread: None,
        });
    }

    let mut child = Command::new(docker_command())
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path.unwrap())?;
    let shared_log = Arc::new(Mutex::new(file));

    let mut stdout_thread = None;
    let mut stderr_thread = None;

    if let Some(mut stdout) = child.stdout.take() {
        let log = Arc::clone(&shared_log);
        stdout_thread = Some(thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            let mut terminal = std::io::stdout();
            while let Ok(size) = stdout.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                let chunk = &buffer[..size];
                let _ = terminal.write_all(chunk);
                let _ = terminal.flush();
                if let Ok(mut file) = log.lock() {
                    let _ = file.write_all(chunk);
                    let _ = file.flush();
                }
            }
        }));
    }

    if let Some(mut stderr) = child.stderr.take() {
        let log = Arc::clone(&shared_log);
        stderr_thread = Some(thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            let mut terminal = std::io::stderr();
            while let Ok(size) = stderr.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                let chunk = &buffer[..size];
                let _ = terminal.write_all(chunk);
                let _ = terminal.flush();
                if let Ok(mut file) = log.lock() {
                    let _ = file.write_all(chunk);
                    let _ = file.flush();
                }
            }
        }));
    }

    Ok(AttachedDockerChild {
        child,
        stdout_thread,
        stderr_thread,
    })
}

#[cfg(test)]
#[path = "docker_cleanup_cases.rs"]
mod tests;
