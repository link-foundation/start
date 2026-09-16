use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::detached_finalize::build_detached_finalize_snippet;
use crate::docker_post_mortem::{
    build_docker_post_mortem_snippet, build_docker_removal_note_snippet,
    build_docker_state_snippet, format_container_post_mortem, format_container_removal_note,
    normalize_docker_timestamp, ContainerPostMortem, DOCKER_STATE_INSPECT_FORMAT,
};
use crate::exit_reason::resolve_memory_exhaustion;
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
/// --network-alias). Returned references borrow
/// from `options`, which outlives the `docker run` invocation.
pub(crate) fn build_docker_runtime_args(options: &IsolationOptions) -> Vec<&str> {
    let mut args: Vec<&str> = Vec::new();
    if options.privileged {
        args.push("--privileged");
    }
    for env_var in &options.env {
        args.push("-e");
        args.push(env_var);
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
pub(crate) enum DockerContainerCleanupPolicy {
    Default,
    Always,
    Keep,
    KeepOnFail,
}

pub(crate) fn docker_command() -> std::ffi::OsString {
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
        "Container kept for investigation: {}\nRe-enter while running: $ --attach {}\nContinue the stored command: $ --resume {}\nRun another command in the same container: $ --resume {} -- <command>\nRemove when done: docker rm -f {}",
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
        if oom_killed {
            message.push_str("\nContainer kept because Docker reports it was OOM-killed.");
        } else {
            message.push_str("\nContainer kept because the command failed.");
        }
        // A runtime that aborts on its own memory limit never trips the
        // container flag, so `oomKilled false` alone would contradict the
        // `FATAL ERROR` the runtime just printed into this very log (issue
        // #165). Best effort: the tail is read right after the child exits.
        let tail = log_path
            .and_then(|path| read_log_tail(&path.to_string_lossy(), FATAL_MARKER_TAIL_BYTES));
        if let Some(memory) =
            resolve_memory_exhaustion(Some(exit_code), tail.as_deref(), Some(oom_killed))
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
        "{}; printf '\\nContainer kept for investigation: %s\\nReason: %s\\nRe-enter while running: $ --attach %s\\nContinue the stored command: $ --resume %s\\nRun another command in the same container: $ --resume %s -- <command>\\nRemove when done: docker rm -f %s\\n' {} \"$__start_command_reason\" {} {} {} {} >> {}",
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
fn build_detached_docker_completion_script(
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
    log_path: Option<&PathBuf>,
    execution_id: Option<&str>,
) -> String {
    let quoted_name = shell_quote(container_name);
    let mut parts = Vec::new();

    if let Some(path) = log_path {
        let log_path_string = path.to_string_lossy().to_string();
        let quoted_log_path = shell_quote(&log_path_string);
        parts.push(format!(
            "docker logs -f {} >> {} 2>&1",
            quoted_name, quoted_log_path
        ));
        parts.push(build_docker_state_snippet(container_name));

        let remove = format!(
            "docker rm -f {} >> {} 2>&1 || true; {}",
            quoted_name,
            quoted_log_path,
            build_docker_removal_note_snippet(container_name, &quoted_log_path)
        );
        // A kept container is exactly the case the user will investigate, so it
        // gets the full post-mortem before the copy-paste instructions.
        let keep = format!(
            "{}; {}",
            build_docker_post_mortem_snippet(container_name, &quoted_log_path),
            build_docker_kept_log_snippet(container_name, &quoted_log_path)
        );
        match policy {
            DockerContainerCleanupPolicy::Always => parts.push(remove),
            DockerContainerCleanupPolicy::Default | DockerContainerCleanupPolicy::KeepOnFail => {
                parts.push(format!(
                    "if {}; then {}; else {}; fi",
                    successful_non_oom_condition(),
                    remove,
                    keep
                ))
            }
            // Previously wrote nothing at all: the container is always kept, so
            // the log said nothing about why it stopped (issue #171.2).
            DockerContainerCleanupPolicy::Keep => parts.push(keep),
        }
        parts.push(format!(
            "{} >> {}",
            create_shell_log_footer_snippet(),
            quoted_log_path
        ));
    } else {
        parts.push(format!("docker wait {} >/dev/null 2>&1", quoted_name));
        parts.push(build_docker_state_snippet(container_name));
        match policy {
            DockerContainerCleanupPolicy::Always => parts.push(format!(
                "docker rm -f {} >/dev/null 2>&1 || true",
                quoted_name
            )),
            DockerContainerCleanupPolicy::Default | DockerContainerCleanupPolicy::KeepOnFail => {
                parts.push(format!(
                    "if {}; then docker rm -f {} >/dev/null 2>&1 || true; fi",
                    successful_non_oom_condition(),
                    quoted_name
                ))
            }
            DockerContainerCleanupPolicy::Keep => {}
        }
    }

    if let Some(execution_id) = execution_id {
        parts.push(build_detached_finalize_snippet(execution_id));
    }

    parts.join("; ")
}

pub(crate) fn start_detached_docker_completion_watcher(
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
    log_path: Option<&PathBuf>,
    execution_id: Option<&str>,
) {
    let script =
        build_detached_docker_completion_script(container_name, policy, log_path, execution_id);
    let _ = Command::new("sh")
        .args(["-c", &script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
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
mod tests {
    use super::*;
    use crate::docker_post_mortem::POST_MORTEM_HEADER;

    #[test]
    fn default_policy_keeps_abnormal_containers() {
        let options = IsolationOptions::default();
        let policy = get_docker_container_cleanup_policy(&options);
        assert_eq!(policy, DockerContainerCleanupPolicy::Default);
        assert!(should_cleanup_docker_container(policy, 0, false));
        assert!(!should_cleanup_docker_container(policy, 7, false));
        assert!(!should_cleanup_docker_container(policy, 0, true));
    }

    #[test]
    fn keep_on_fail_policy_keeps_oom_killed_containers() {
        let options = IsolationOptions {
            keep_container_on_fail: true,
            ..IsolationOptions::default()
        };
        let policy = get_docker_container_cleanup_policy(&options);
        assert_eq!(policy, DockerContainerCleanupPolicy::KeepOnFail);
        assert!(should_cleanup_docker_container(policy, 0, false));
        assert!(!should_cleanup_docker_container(policy, 0, true));
    }

    #[test]
    fn explicit_always_policy_cleans_abnormal_containers() {
        let options = IsolationOptions {
            always_cleanup_container: true,
            ..IsolationOptions::default()
        };
        let policy = get_docker_container_cleanup_policy(&options);
        assert_eq!(policy, DockerContainerCleanupPolicy::Always);
        assert!(should_cleanup_docker_container(policy, 7, false));
        assert!(should_cleanup_docker_container(policy, 0, true));
    }

    #[test]
    fn detached_watcher_inspects_oom_killed_before_default_cleanup() {
        let log_path = PathBuf::from("/tmp/issue144.log");
        let script = build_detached_docker_completion_script(
            "issue144-container",
            DockerContainerCleanupPolicy::Default,
            Some(&log_path),
            None,
        );
        assert!(script.contains(".State.ExitCode"));
        assert!(script.contains(".State.OOMKilled"));
        assert!(script.contains("__start_command_oom"));
        assert!(script.contains("Container kept for investigation"));
        assert!(script.contains("docker rm -f"));
        assert!(script.contains("issue144-container"));
    }

    /// Evaluate the reason snippet the way the watcher does, in a real shell.
    #[cfg(unix)]
    fn evaluate_reason(exit_code: &str, oom_killed: &str) -> String {
        let output = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "__start_command_exit={}; __start_command_oom={}; {}; printf '%s' \"$__start_command_reason\"",
                exit_code,
                oom_killed,
                build_docker_kept_reason_snippet()
            ))
            .output()
            .expect("sh");
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    #[cfg(unix)]
    fn kept_footer_does_not_assert_a_bare_oom_false_for_self_aborts() {
        // The footer is printed a few lines below the runtime's own
        // `FATAL ERROR: Reached heap limit ...`; it must not contradict it.
        for exit_code in SELF_ABORT_EXIT_CODES {
            let reason = evaluate_reason(&exit_code.to_string(), "false");
            assert!(reason.contains(&format!("exitCode={} oomKilled=false", exit_code)));
            assert!(reason.contains("invisible to this flag"));
        }
    }

    #[test]
    #[cfg(unix)]
    fn kept_footer_stays_plain_for_other_exits_and_real_oom_kills() {
        assert_eq!(evaluate_reason("1", "false"), "exitCode=1 oomKilled=false");
        assert_eq!(
            evaluate_reason("137", "true"),
            "exitCode=137 oomKilled=true"
        );
    }

    #[test]
    fn detached_watcher_computes_the_kept_reason() {
        let log_path = PathBuf::from("/tmp/issue165.log");
        let script = build_detached_docker_completion_script(
            "issue165-container",
            DockerContainerCleanupPolicy::Default,
            Some(&log_path),
            None,
        );
        assert!(script.contains("__start_command_reason="));
        assert!(script.contains("Reason: %s"));
    }

    /// Issue #170.1: the watcher must hand the terminal state to the finalizer,
    /// so a detached record stops being `executing` forever.
    #[test]
    fn detached_watcher_invokes_the_finalizer_with_the_inspected_facts() {
        let log_path = PathBuf::from("/tmp/issue170.log");
        let script = build_detached_docker_completion_script(
            "issue170-container",
            DockerContainerCleanupPolicy::Default,
            Some(&log_path),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
        );
        assert!(script.contains(crate::detached_finalize::INTERNAL_FINALIZE_FLAG));
        assert!(script.contains("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        assert!(script.contains("$__start_command_exit"));
        assert!(script.contains("$__start_command_finished"));
        // Bookkeeping runs last: a record only becomes terminal once the log is
        // complete, and a failed finalization can never abort the cleanup.
        let finalize_at = script
            .find(crate::detached_finalize::INTERNAL_FINALIZE_FLAG)
            .unwrap();
        let footer_at = script.find("Exit Code: %s").unwrap();
        assert!(finalize_at > footer_at);
    }

    /// Without an execution id (an un-tracked run) nothing is finalized.
    #[test]
    fn detached_watcher_stays_backward_compatible_without_an_execution_id() {
        let log_path = PathBuf::from("/tmp/issue170.log");
        let script = build_detached_docker_completion_script(
            "issue170-container",
            DockerContainerCleanupPolicy::Default,
            Some(&log_path),
            None,
        );
        assert!(!script.contains(crate::detached_finalize::INTERNAL_FINALIZE_FLAG));
    }

    /// Issue #171.1/.2/.3: every cleanup path states the post-mortem facts.
    #[test]
    fn detached_watcher_writes_the_post_mortem_on_both_paths() {
        let log_path = PathBuf::from("/tmp/issue171.log");
        let script = build_detached_docker_completion_script(
            "issue171-container",
            DockerContainerCleanupPolicy::KeepOnFail,
            Some(&log_path),
            None,
        );
        assert!(script.contains("{{.State.StartedAt}}"));
        assert!(script.contains("{{.State.FinishedAt}}"));
        assert!(script.contains("{{.State.Error}}"));
        assert!(script.contains("=== Container post-mortem ==="));
        assert!(script.contains("Container removed:"));
        assert!(script.contains("Container kept for investigation"));
    }

    /// A container that is always kept used to produce no completion output at
    /// all; it must still get its post-mortem (issue #171.2).
    #[test]
    fn always_kept_containers_still_get_a_post_mortem() {
        let log_path = PathBuf::from("/tmp/issue171.log");
        let script = build_detached_docker_completion_script(
            "issue171-container",
            DockerContainerCleanupPolicy::Keep,
            Some(&log_path),
            None,
        );
        assert!(script.contains("=== Container post-mortem ==="));
        // The only `docker rm -f` left is the copy-paste hint in the kept message.
        assert!(!script.contains("docker rm -f 'issue171-container' >>"));
    }

    /// The removal path is the one issue #171.3 is about: at least one line.
    #[test]
    fn always_removed_containers_get_the_removal_note() {
        let log_path = PathBuf::from("/tmp/issue171.log");
        let script = build_detached_docker_completion_script(
            "issue171-container",
            DockerContainerCleanupPolicy::Always,
            Some(&log_path),
            None,
        );
        assert!(script.contains("Container removed:"));
        assert!(script.contains("docker rm -f 'issue171-container' >>"));
    }

    #[test]
    fn attached_runs_read_every_documented_fact_in_one_inspect() {
        let facts = parse_docker_container_state(
            "demo",
            "137 false 2026-09-15T22:21:40.942007645Z 2026-09-15T22:21:46.740817278Z",
            Some(""),
        );

        assert_eq!(facts.container_name, "demo");
        assert_eq!(facts.exit_code, Some(137));
        assert_eq!(facts.oom_killed, Some(false));
        assert_eq!(
            facts.started_at.as_deref(),
            Some("2026-09-15T22:21:40.942007645Z")
        );
        assert_eq!(
            facts.finished_at.as_deref(),
            Some("2026-09-15T22:21:46.740817278Z")
        );
        assert_eq!(facts.error, None);
    }

    #[test]
    fn attached_runs_reject_the_zero_time_of_a_container_that_never_started() {
        let facts = parse_docker_container_state(
            "demo",
            "125 false 0001-01-01T00:00:00Z 0001-01-01T00:00:00Z",
            Some("no such file or directory"),
        );

        assert_eq!(facts.started_at, None);
        assert_eq!(facts.finished_at, None);
        assert_eq!(facts.error.as_deref(), Some("no such file or directory"));
    }

    #[test]
    fn attached_runs_survive_an_inspect_that_answered_nothing_useful() {
        let facts = parse_docker_container_state("demo", "", None);

        assert_eq!(facts.exit_code, None);
        assert_eq!(facts.oom_killed, None);
        assert_eq!(facts.started_at, None);
        assert_eq!(facts.error, None);
    }

    #[test]
    fn attached_kept_containers_get_the_post_mortem_block_in_their_log() {
        let dir =
            std::env::temp_dir().join(format!("start-attached-kept-171-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log_path = dir.join("run.log");
        std::fs::write(&log_path, "output\n").unwrap();

        let facts = ContainerPostMortem {
            container_name: "demo".to_string(),
            exit_code: Some(137),
            oom_killed: Some(false),
            started_at: Some("2026-09-15T22:21:40.942007645Z".to_string()),
            finished_at: Some("2026-09-15T22:21:46.740817278Z".to_string()),
            error: None,
        };
        let message = record_attached_docker_post_mortem(Some(&facts), Some(&log_path), false);

        let log = std::fs::read_to_string(&log_path).unwrap();
        assert!(log.contains(POST_MORTEM_HEADER));
        assert!(log.contains("Exit Code:  137 (SIGKILL - 128+9)"));
        assert!(log.contains("Lifetime:   5.798s"));
        assert!(message.contains(POST_MORTEM_HEADER));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attached_removed_containers_get_the_one_line_note() {
        let dir =
            std::env::temp_dir().join(format!("start-attached-removed-171-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log_path = dir.join("run.log");
        std::fs::write(&log_path, "output\n").unwrap();

        let facts = ContainerPostMortem {
            container_name: "demo".to_string(),
            exit_code: Some(0),
            oom_killed: Some(false),
            started_at: Some("2026-09-15T22:21:40.942007645Z".to_string()),
            finished_at: Some("2026-09-15T22:21:46.740817278Z".to_string()),
            error: None,
        };
        let message = record_attached_docker_post_mortem(Some(&facts), Some(&log_path), true);

        assert!(std::fs::read_to_string(&log_path)
            .unwrap()
            .contains("Container removed: demo (exit 0, lifetime 5.798s, oomKilled=false)"));
        assert_eq!(
            message,
            "\nContainer removed: demo (exit 0, lifetime 5.798s, oomKilled=false)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attached_runs_stay_silent_when_docker_could_not_be_inspected() {
        let dir =
            std::env::temp_dir().join(format!("start-attached-silent-171-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log_path = dir.join("run.log");
        std::fs::write(&log_path, "output\n").unwrap();

        assert_eq!(
            record_attached_docker_post_mortem(None, Some(&log_path), false),
            ""
        );
        assert_eq!(std::fs::read_to_string(&log_path).unwrap(), "output\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
