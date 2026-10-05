//! Launch-time recovery for killed detached docker sessions (issue #176).
//!
//! `$ --isolated docker --detached --on-kill-resume 3 --recovery-command B -- A`
//! runs `A`; when the main process is killed (exit 137, or `OOMKilled` with no
//! exit status of its own), the detached completion watcher hands the inspected
//! facts to this module, which restarts the *same* container so `B` continues
//! on the same filesystem, with the same resource limits (they live in the
//! container's HostConfig), under the same execution UUID and appending to the
//! same log file.
//!
//! How `B` replaces `A` inside the same container: a container launched with a
//! recovery command runs a tiny selector as its command. The selector runs `A`
//! normally, but runs `B` when the marker file exists. Before `docker start`,
//! the marker (holding the attempt number) is copied into the stopped
//! container with `docker cp`. Without a recovery command the original command
//! is simply started again.
//!
//! Like `detached_finalize`, the entry point runs as a short-lived child of the
//! watcher on a host whose CLI invocation is long gone, so it never panics on
//! bad input and never prints anything.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::detached_finalize::{normalize_bool, normalize_container_error};
use crate::docker_cleanup::{
    docker_command, get_docker_container_cleanup_policy,
    start_detached_docker_completion_watcher_with, DockerWatcherOptions,
};
use crate::docker_post_mortem::{format_container_post_mortem, shell_vars, ContainerPostMortem};
use crate::docker_resource_limits::{
    build_resource_limits_status_line, read_docker_resource_limits,
};
use crate::execution_control::{CommandRunOutput, CommandRunner, SystemCommandRunner};
use crate::execution_resume::build_launch_options;
use crate::execution_store::{
    ExecutionRecord, ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
};
use crate::exit_reason::describe_exit_code_str;
use crate::isolation::isolation_log::shell_quote;
use crate::recovery_delay::{
    format_recovery_delay, pick_recovery_delay_ms, record_on_kill_resume_delay, system_random,
    system_sleep, wait_for_recovery_delay,
};

/// Hidden argument the detached watcher re-invokes this binary with.
pub const INTERNAL_RECOVER_FLAG: &str = "--internal-recover-detached-docker";

/// File whose presence makes the selector run the recovery command.
pub const RECOVERY_MARKER_PATH: &str = "/.start-command-recovery";

/// Environment variable carrying the attempt number into the recovery command.
pub const RECOVERY_ATTEMPT_ENV: &str = "START_COMMAND_RECOVERY_ATTEMPT";

/// Exit code of a process killed with SIGKILL (the OOM killer's signal).
pub const KILLED_EXIT_CODE: i32 = 137;

/// POSIX selector run as the container command when a recovery command is set:
/// `sh -c SELECTOR start-command <shell> <flag> <recovery> <main argv...>`.
pub fn recovery_selector() -> String {
    format!(
        "s=$1; f=$2; r=$3; shift 3; if [ -e {marker} ]; then {env}=$(cat {marker} 2>/dev/null); export {env}; if [ -n \"$f\" ]; then exec \"$s\" \"$f\" -c \"$r\"; fi; exec \"$s\" -c \"$r\"; fi; exec \"$@\"",
        marker = RECOVERY_MARKER_PATH,
        env = RECOVERY_ATTEMPT_ENV
    )
}

/// Wrap the container command so a later `docker start` can switch to the
/// recovery command.
pub fn build_recovery_selector_args(
    main_args: &[String],
    shell: &str,
    shell_flag: Option<&str>,
    recovery_command: &str,
) -> Vec<String> {
    let mut args = vec![
        "sh".to_string(),
        "-c".to_string(),
        recovery_selector(),
        "start-command".to_string(),
        if shell.is_empty() { "sh" } else { shell }.to_string(),
        shell_flag.unwrap_or("").to_string(),
        recovery_command.to_string(),
    ];
    args.extend(main_args.iter().cloned());
    args
}

/// Whether the inspected facts describe a killed main process.
///
/// Exit 137 (SIGKILL, the OOM killer's signal) always counts. `OOMKilled`
/// alone does not: Docker sets it when *any* process in the container's
/// cgroup was OOM-killed (a compiler, a test runner, a child `node`), and it
/// stays set until the container is started again. A main process that
/// survived that and then exited 0-127 on its own ran to completion, so the
/// flag only counts when there is no usable exit status (the watcher's `-1`,
/// or nothing at all) (issue #178).
pub fn is_killed_exit(exit_code: &str, oom_killed: &str) -> bool {
    let code = describe_exit_code_str(exit_code).code;
    if code == Some(KILLED_EXIT_CODE) {
        return true;
    }
    normalize_bool(oom_killed) == Some(true) && code.is_none_or(|code| code < 0)
}

/// Shell condition run by the completion watcher: true when the container was
/// killed and the recovery entry point resumed it. Mirrors `is_killed_exit`:
/// `OOMKilled` only counts without a non-negative exit code (issue #178).
pub fn build_recovery_snippet(execution_id: &str) -> String {
    let executable = std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| "start".to_string());
    format!(
        "{{ [ \"${exit}\" = {code} ] || {{ [ \"${oom}\" = true ] && ! [ \"${exit}\" -ge 0 ] 2>/dev/null; }}; }} && {exe} {flag} {id} \"${exit}\" \"${oom}\" \"${started}\" \"${finished}\" \"${error}\" >/dev/null 2>&1",
        exit = shell_vars::EXIT,
        oom = shell_vars::OOM,
        started = shell_vars::STARTED,
        finished = shell_vars::FINISHED,
        error = shell_vars::ERROR,
        code = KILLED_EXIT_CODE,
        exe = shell_quote(&executable),
        flag = INTERNAL_RECOVER_FLAG,
        id = shell_quote(execution_id),
    )
}

/// What the `[Recovery k/N]` separator reports.
pub struct RecoverySeparator<'a> {
    pub attempt: u64,
    pub max_attempts: u64,
    pub exit_code: &'a str,
    pub oom_killed: &'a str,
    pub container_name: &'a str,
    pub command: Option<&'a str>,
    /// Random `--on-kill-resume-delay` wait before the resume (issue #181).
    pub delay_ms: u64,
}

/// The `[Recovery k/N]` separator written into the session log.
pub fn format_recovery_separator(params: &RecoverySeparator) -> String {
    let described = describe_exit_code_str(params.exit_code);
    let code = described
        .code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let signal = described
        .signal
        .map(|name| format!(", {}", name))
        .unwrap_or_default();
    let what = match params.command {
        Some(command) => format!("running recovery command: {}", command),
        None => "running the original command again".to_string(),
    };
    let delay = if params.delay_ms > 0 {
        format!(" after a {} delay", format_recovery_delay(params.delay_ms))
    } else {
        String::new()
    };
    format!(
        "\n[Recovery {}/{}] Main process was killed (exit {}{}, oomKilled={}); resuming container {}{}, {}\n",
        params.attempt,
        params.max_attempts,
        code,
        signal,
        normalize_bool(params.oom_killed) == Some(true),
        params.container_name,
        delay,
        what
    )
}

/// The docker facts the watcher hands over.
#[derive(Debug, Clone, Default)]
pub struct RecoveryFacts {
    pub exit_code: String,
    pub oom_killed: String,
    pub started_at: String,
    pub finished_at: String,
    pub container_error: String,
}

/// Outcome of a recovery attempt; `recovered` is true only when the container
/// was started again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryOutcome {
    pub recovered: bool,
    pub reason: String,
    pub attempt: Option<u64>,
    /// The `--on-kill-resume-delay` wait, when one is configured (issue #181).
    pub delay_ms: Option<u64>,
}

impl RecoveryOutcome {
    fn not(reason: &str) -> Self {
        RecoveryOutcome {
            recovered: false,
            reason: reason.to_string(),
            attempt: None,
            delay_ms: None,
        }
    }
}

/// Where the `--on-kill-resume-delay` wait gets its randomness and sleeps;
/// tests swap both out (issue #181).
pub struct RecoveryDelayHooks<'a> {
    pub random: &'a dyn Fn() -> f64,
    pub sleep: &'a dyn Fn(u64),
}

impl Default for RecoveryDelayHooks<'_> {
    fn default() -> Self {
        RecoveryDelayHooks {
            random: &system_random,
            sleep: &system_sleep,
        }
    }
}

fn is_stop_requested(store: &ExecutionStore, execution_id: &str) -> bool {
    store
        .get(execution_id)
        .is_some_and(|record| option_str(&record, "stopRequestedAt").is_some())
}

/// Starts the completion watcher that follows a resumed container.
pub type WatcherStarter<'a> = &'a dyn Fn(&str, &ExecutionRecord, &DockerWatcherOptions);

fn append_to_log(log_path: &str, text: &str) {
    if log_path.is_empty() {
        return;
    }
    // The log is best-effort here: recovery itself must still proceed.
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = file.write_all(text.as_bytes());
    }
}

fn failure_detail(result: &CommandRunOutput) -> String {
    let stderr = result.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    result.error.clone().unwrap_or_else(|| {
        format!(
            "exit code {}",
            result
                .status
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )
    })
}

fn write_recovery_marker<R: CommandRunner + ?Sized>(
    container_name: &str,
    attempt: u64,
    runner: &R,
) -> CommandRunOutput {
    let dir = std::env::temp_dir().join(format!("start-recovery-{}", uuid::Uuid::new_v4()));
    let file = dir.join("marker");
    let written = fs::create_dir_all(&dir).and_then(|_| fs::write(&file, format!("{}\n", attempt)));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o644));
    }
    let result = match written {
        Ok(()) => runner.run(
            &docker_command().to_string_lossy(),
            &[
                "cp".to_string(),
                file.to_string_lossy().to_string(),
                format!("{}:{}", container_name, RECOVERY_MARKER_PATH),
            ],
        ),
        Err(err) => CommandRunOutput {
            success: false,
            error: Some(err.to_string()),
            ..CommandRunOutput::default()
        },
    };
    let _ = fs::remove_dir_all(&dir);
    result
}

fn option_u64(record: &ExecutionRecord, key: &str) -> u64 {
    match record.options.get(key) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn option_str<'a>(record: &'a ExecutionRecord, key: &str) -> Option<&'a str> {
    record
        .options
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// Resume a killed execution in its own container.
pub fn recover_killed_execution<R: CommandRunner + ?Sized>(
    store: &ExecutionStore,
    execution_id: &str,
    facts: &RecoveryFacts,
    runner: &R,
    start_watcher: WatcherStarter,
) -> RecoveryOutcome {
    recover_killed_execution_with_delay(
        store,
        execution_id,
        facts,
        runner,
        start_watcher,
        &RecoveryDelayHooks::default(),
    )
}

/// [`recover_killed_execution`] after the random `--on-kill-resume-delay`
/// wait (issue #181), with injectable randomness and sleep.
pub fn recover_killed_execution_with_delay<R: CommandRunner + ?Sized>(
    store: &ExecutionStore,
    execution_id: &str,
    facts: &RecoveryFacts,
    runner: &R,
    start_watcher: WatcherStarter,
    delay: &RecoveryDelayHooks,
) -> RecoveryOutcome {
    if execution_id.is_empty() {
        return RecoveryOutcome::not("missing-arguments");
    }
    let Some(mut record) = store.get(execution_id) else {
        return RecoveryOutcome::not("record-not-found");
    };
    let max_attempts = option_u64(&record, "onKillResume");
    let container_name = option_str(&record, "sessionName").map(str::to_string);
    let Some(container_name) = container_name
        .filter(|_| option_str(&record, "isolated") == Some("docker") && max_attempts >= 1)
    else {
        return RecoveryOutcome::not("not-configured");
    };
    if !is_killed_exit(&facts.exit_code, &facts.oom_killed) {
        return RecoveryOutcome::not("not-killed");
    }
    let log_path = record.log_path.clone();
    let log = |text: &str| append_to_log(&log_path, text);
    if option_str(&record, "stopRequestedAt").is_some() {
        log("\n[Recovery] Not resuming: the session was stopped on request.\n");
        return RecoveryOutcome::not("stop-requested");
    }
    let used = option_u64(&record, "recoveryAttempts");
    if used >= max_attempts {
        log(&format!(
            "\n[Recovery] Not resuming: all {} recovery attempt(s) used.\n",
            max_attempts
        ));
        return RecoveryOutcome::not("attempts-exhausted");
    }

    let attempt = used + 1;
    let delay_range = record_on_kill_resume_delay(record.options.get("onKillResumeDelay"));
    let delay_ms = pick_recovery_delay_ms(delay_range.as_deref(), delay.random);
    let give_up = |reason: String| {
        log(&format!(
            "[Recovery {}/{}] Failed: {}\n",
            attempt, max_attempts, reason
        ));
        RecoveryOutcome {
            recovered: false,
            reason: "resume-failed".to_string(),
            attempt: Some(attempt),
            delay_ms: None,
        }
    };

    let oom_killed = normalize_bool(&facts.oom_killed);
    log(&format!(
        "\n{}",
        format_container_post_mortem(&ContainerPostMortem {
            container_name: container_name.clone(),
            exit_code: describe_exit_code_str(&facts.exit_code).code,
            oom_killed,
            started_at: Some(facts.started_at.clone()),
            finished_at: Some(facts.finished_at.clone()),
            error: normalize_container_error(&facts.container_error),
        })
    ));
    let recovery_command = option_str(&record, "recoveryCommand").map(str::to_string);
    log(&format_recovery_separator(&RecoverySeparator {
        attempt,
        max_attempts,
        exit_code: &facts.exit_code,
        oom_killed: &facts.oom_killed,
        container_name: &container_name,
        command: recovery_command.as_deref(),
        delay_ms,
    }));

    // Executions killed by one host-wide OOM event must not all come back in
    // the same second (issue #181). `--stop` during the wait cancels the
    // resume: the container has already exited, so `docker stop` only leaves
    // the `stopRequestedAt` marker this loop polls for.
    if delay_ms > 0
        && wait_for_recovery_delay(delay_ms, delay.sleep, &|| {
            is_stop_requested(store, execution_id)
        })
    {
        log(&format!(
            "[Recovery {}/{}] Not resuming: the session was stopped on request during the delay.\n",
            attempt, max_attempts
        ));
        return RecoveryOutcome {
            recovered: false,
            reason: "stop-requested".to_string(),
            attempt: Some(attempt),
            delay_ms: Some(delay_ms),
        };
    }

    // Docker keeps `docker update` limits in the HostConfig across restarts;
    // they are read back so the log and `--status` show what the resumed run
    // is held to, and so a later relaunch can re-apply them.
    let resource_limits = read_docker_resource_limits(&container_name, runner).unwrap_or_default();
    if let Some(line) = build_resource_limits_status_line(&resource_limits) {
        log(&format!("{}\n", line));
    }

    if recovery_command.is_some() {
        let copied = write_recovery_marker(&container_name, attempt, runner);
        if !copied.success {
            return give_up(format!(
                "could not mark the container: {}",
                failure_detail(&copied)
            ));
        }
    }

    let since = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let started = runner.run(
        &docker_command().to_string_lossy(),
        &["start".to_string(), container_name.clone()],
    );
    if !started.success {
        return give_up(format!("docker start failed: {}", failure_detail(&started)));
    }

    let described = describe_exit_code_str(&facts.exit_code);
    let mut history = record
        .options
        .get("recoveryHistory")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let delayed = if delay_range.is_some() {
        format!(", delayMs={}", delay_ms)
    } else {
        String::new()
    };
    history.push(json!(format!(
        "{}: exit {}, oomKilled={}{}, resumed at {}",
        attempt,
        described
            .code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        oom_killed == Some(true),
        delayed,
        since
    )));
    let options = &mut record.options;
    options.insert("recoveryAttempts".to_string(), json!(attempt));
    options.insert("recoveryHistory".to_string(), Value::Array(history));
    options.insert("lastRecoveryAt".to_string(), json!(since));
    if delay_range.is_some() {
        options.insert("lastRecoveryDelayMs".to_string(), json!(delay_ms));
    }
    if !resource_limits.is_empty() {
        options.insert("resourceLimits".to_string(), json!(resource_limits));
    }
    record.status = ExecutionStatus::Executing;
    record.exit_code = None;
    record.end_time = None;
    record.exit_reason = None;
    record.oom_killed = None;
    // The container is already running again; even if the save fails, the new
    // watcher still follows it and finalizes the record when it ends.
    let _ = store.save(&record);

    start_watcher(
        &container_name,
        &record,
        &DockerWatcherOptions {
            since: Some(since),
            recover_on_kill: true,
        },
    );
    RecoveryOutcome {
        recovered: true,
        reason: "resumed".to_string(),
        attempt: Some(attempt),
        delay_ms: delay_range.map(|_| delay_ms),
    }
}

/// The real watcher: a detached shell following the resumed container.
pub fn start_system_watcher(
    container_name: &str,
    record: &ExecutionRecord,
    watcher: &DockerWatcherOptions,
) {
    let log_path = (!record.log_path.is_empty()).then(|| PathBuf::from(&record.log_path));
    start_detached_docker_completion_watcher_with(
        container_name,
        get_docker_container_cleanup_policy(&build_launch_options(record)),
        log_path.as_ref(),
        Some(record.uuid.as_str()),
        watcher,
    );
}

/// Entry point for `--internal-recover-detached-docker <uuid> <exit> <oom>
/// <started> <finished> <error>`. Returns 0 only when the container was
/// resumed; any other outcome lets the watcher continue with its normal
/// cleanup, footer and finalization.
pub fn run_internal_recover(args: &[String]) -> i32 {
    let execution_id = match args.first() {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return 1,
    };
    if std::env::var("START_DISABLE_TRACKING").as_deref() == Ok("true") {
        return 1;
    }
    let field = |index: usize| args.get(index).cloned().unwrap_or_default();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: std::env::var("START_APP_FOLDER").ok().map(PathBuf::from),
        ..ExecutionStoreOptions::default()
    });
    let outcome = recover_killed_execution(
        &store,
        &execution_id,
        &RecoveryFacts {
            exit_code: field(1),
            oom_killed: field(2),
            started_at: field(3),
            finished_at: field(4),
            container_error: field(5),
        },
        &SystemCommandRunner,
        &start_system_watcher,
    );
    if outcome.recovered {
        0
    } else {
        1
    }
}
