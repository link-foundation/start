use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::isolation::isolation_log::{
    append_log_file, create_shell_log_footer_snippet, shell_quote,
};
use crate::isolation::IsolationOptions;

/// Build the extra `docker run` arguments contributed by runtime options
/// (--privileged, --env/-e, --volume/-v, --mount). Returned references borrow
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
    args
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
        "Container kept for investigation: {}\nInspect: docker exec -it {} sh (if running) or docker start -ai {}\nRemove when done: docker rm -f {}",
        container_name, container_name, container_name, container_name
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

pub(crate) fn read_docker_container_oom_killed(container_name: &str) -> Option<bool> {
    let output = Command::new(docker_command())
        .args(["inspect", "-f", "{{.State.OOMKilled}}", container_name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
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
        "printf '\\nContainer kept for investigation: %s\\nReason: exitCode=%s oomKilled=%s\\nInspect: docker exec -it %s sh (if running) or docker start -ai %s\\nRemove when done: docker rm -f %s\\n' {} \"$__start_command_exit\" \"$__start_command_oom\" {} {} {} >> {}",
        quoted_name, quoted_name, quoted_name, quoted_name, quoted_log_path
    )
}

fn successful_non_oom_condition() -> &'static str {
    "[ \"$__start_command_exit\" -eq 0 ] 2>/dev/null && [ \"$__start_command_oom\" != true ]"
}

fn build_detached_docker_completion_script(
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
    log_path: Option<&PathBuf>,
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
        parts.push(format!(
            "__start_command_state=$(docker inspect -f '{{{{.State.ExitCode}}}} {{{{.State.OOMKilled}}}}' {} 2>/dev/null || printf '%s' '-1 false')",
            quoted_name
        ));
        parts.push("__start_command_exit=${__start_command_state%% *}".to_string());
        parts.push("__start_command_oom=${__start_command_state##* }".to_string());
        match policy {
            DockerContainerCleanupPolicy::Always => parts.push(format!(
                "docker rm -f {} >> {} 2>&1 || true",
                quoted_name, quoted_log_path
            )),
            DockerContainerCleanupPolicy::Default => parts.push(format!(
                "if {}; then docker rm -f {} >> {} 2>&1 || true; else {}; fi",
                successful_non_oom_condition(),
                quoted_name,
                quoted_log_path,
                build_docker_kept_log_snippet(container_name, &quoted_log_path)
            )),
            DockerContainerCleanupPolicy::KeepOnFail => parts.push(format!(
                "if {}; then docker rm -f {} >> {} 2>&1 || true; else {}; fi",
                successful_non_oom_condition(),
                quoted_name,
                quoted_log_path,
                build_docker_kept_log_snippet(container_name, &quoted_log_path)
            )),
            DockerContainerCleanupPolicy::Keep => {}
        }
        parts.push(format!(
            "{} >> {}",
            create_shell_log_footer_snippet(),
            quoted_log_path
        ));
    } else {
        parts.push(format!("docker wait {} >/dev/null 2>&1", quoted_name));
        parts.push(format!(
            "__start_command_state=$(docker inspect -f '{{{{.State.ExitCode}}}} {{{{.State.OOMKilled}}}}' {} 2>/dev/null || printf '%s' '-1 false')",
            quoted_name
        ));
        parts.push("__start_command_exit=${__start_command_state%% *}".to_string());
        parts.push("__start_command_oom=${__start_command_state##* }".to_string());
        match policy {
            DockerContainerCleanupPolicy::Always => parts.push(format!(
                "docker rm -f {} >/dev/null 2>&1 || true",
                quoted_name
            )),
            DockerContainerCleanupPolicy::Default => parts.push(format!(
                "if {}; then docker rm -f {} >/dev/null 2>&1 || true; fi",
                successful_non_oom_condition(),
                quoted_name
            )),
            DockerContainerCleanupPolicy::KeepOnFail => parts.push(format!(
                "if {}; then docker rm -f {} >/dev/null 2>&1 || true; fi",
                successful_non_oom_condition(),
                quoted_name
            )),
            DockerContainerCleanupPolicy::Keep => {}
        }
    }

    parts.join("; ")
}

pub(crate) fn start_detached_docker_completion_watcher(
    container_name: &str,
    policy: DockerContainerCleanupPolicy,
    log_path: Option<&PathBuf>,
) {
    let script = build_detached_docker_completion_script(container_name, policy, log_path);
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
        );
        assert!(script.contains(".State.ExitCode"));
        assert!(script.contains(".State.OOMKilled"));
        assert!(script.contains("__start_command_oom"));
        assert!(script.contains("Container kept for investigation"));
        assert!(script.contains("docker rm -f"));
        assert!(script.contains("issue144-container"));
    }
}
