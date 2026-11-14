//! Regression tests for issue #265: `--stop` on a docker execution used
//! Docker's default 10 s grace period, so a graceful-shutdown handler that
//! needs longer was SIGKILLed (exit 137) before it could finish. The grace
//! period is now configurable:
//!
//! ```text
//! start --stop <uuid> --stop-timeout <s>                   -> docker stop -t <s>
//! start --isolated docker --stop-timeout <s> -- <command>  -> docker run --stop-timeout <s>
//! START_DOCKER_STOP_TIMEOUT=<s>                            -> default for both
//! ```
//!
//! and the stop message says how long the container has before SIGKILL.

use serde_json::json;
use start_command::docker_stop_timeout::{
    resolve_stop_timeout, validate_with_env, StopTimeout, DOCKER_DEFAULT_STOP_TIMEOUT,
    DOCKER_STOP_TIMEOUT_ENV,
};
use start_command::execution_resume::{build_launch_options, build_resume_plan};
use start_command::isolation::build_docker_runtime_args;
use start_command::isolation_metadata::{
    build_isolation_options_map, docker_runtime_status_lines_for_options,
};
use start_command::{
    control_execution_with_runner_and_options, get_control_command_with_options, parse_args,
    CommandRunOutput, CommandRunner, ControlAction, ControlOptions, ExecutionRecord,
    ExecutionStore, ExecutionStoreOptions, IsolationOptions, SessionProbe, SessionState,
    WrapperOptions,
};
use std::cell::RefCell;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

const UUID: &str = "26500000-0000-4000-8000-000000000265";

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn env_with(value: Option<&str>) -> impl Fn(&str) -> Option<String> {
    let value = value.map(str::to_string);
    move |name: &str| {
        assert_eq!(name, DOCKER_STOP_TIMEOUT_ENV);
        value.clone()
    }
}

/// Parse, then resolve `stop_timeout` against an explicit environment value.
fn parse_with_env(items: &[&str], env_value: Option<&str>) -> Result<WrapperOptions, String> {
    let mut options = parse_args(&args(items))?.wrapper_options;
    // parse_args resolved against the real environment; start over.
    if !items.iter().any(|item| item.starts_with("--stop-timeout")) {
        options.stop_timeout = None;
    }
    validate_with_env(&mut options, &env_with(env_value))?;
    Ok(options)
}

#[test]
fn parses_both_flag_forms_with_stop_and_on_docker_launches() {
    let stop = parse_with_env(&["--stop", UUID, "--stop-timeout", "120"], None).unwrap();
    assert_eq!(stop.stop.as_deref(), Some(UUID));
    assert_eq!(stop.stop_timeout, Some(120));
    let zero = parse_with_env(&["--stop", UUID, "--stop-timeout=0"], None).unwrap();
    assert_eq!(zero.stop_timeout, Some(0));
    let launch = parse_with_env(&["-i", "docker", "--stop-timeout", "30", "--", "ls"], None);
    assert_eq!(launch.unwrap().stop_timeout, Some(30));
}

#[test]
fn rejects_missing_negative_fractional_and_textual_values() {
    for argv in [
        vec!["--stop", UUID, "--stop-timeout"],
        vec!["--stop", UUID, "--stop-timeout", "-5"],
    ] {
        let error = parse_args(&args(&argv)).err().unwrap();
        assert!(error.contains("requires a number of seconds"), "{}", error);
    }
    for value in ["1.5", "ten", "10s", ""] {
        let flag = format!("--stop-timeout={}", value);
        let error = parse_args(&args(&["--stop", UUID, &flag])).err().unwrap();
        assert!(
            error.contains("non-negative whole number of seconds"),
            "{}",
            error
        );
    }
}

#[test]
fn rejects_the_flag_outside_stop_and_docker_launches() {
    for argv in [
        vec!["--stop-timeout", "30", "--", "ls"],
        vec!["-i", "screen", "--stop-timeout", "30", "--", "ls"],
        vec!["--terminate", UUID, "--stop-timeout", "30"],
    ] {
        let error = parse_args(&args(&argv)).err().unwrap();
        assert!(
            error.contains("only valid with --stop or when isolation stack includes docker"),
            "{:?}: {}",
            argv,
            error
        );
    }
}

#[test]
fn docker_launch_defaults_from_the_environment() {
    let launch = ["-i", "docker", "--", "ls"];
    assert_eq!(
        parse_with_env(&launch, Some("90")).unwrap().stop_timeout,
        Some(90)
    );
    assert_eq!(parse_with_env(&launch, None).unwrap().stop_timeout, None);
    assert_eq!(
        parse_with_env(&launch, Some("")).unwrap().stop_timeout,
        None
    );
    // The flag wins over the environment.
    let flagged = ["-i", "docker", "--stop-timeout", "5", "--", "ls"];
    assert_eq!(
        parse_with_env(&flagged, Some("90")).unwrap().stop_timeout,
        Some(5)
    );
    // Non-docker launches ignore it.
    let screen = ["-i", "screen", "--", "ls"];
    assert_eq!(
        parse_with_env(&screen, Some("90")).unwrap().stop_timeout,
        None
    );
    let error = parse_with_env(&launch, Some("soon")).err().unwrap();
    assert!(error.contains("Invalid START_DOCKER_STOP_TIMEOUT value"));
}

#[test]
fn validating_again_keeps_the_result() {
    let mut options = parse_with_env(&["-i", "docker", "--", "ls"], Some("7")).unwrap();
    validate_with_env(&mut options, &env_with(None)).unwrap();
    assert_eq!(options.stop_timeout, Some(7));
}

#[test]
fn docker_run_gets_stop_timeout_after_init_and_records_it() {
    let options = IsolationOptions {
        privileged: true,
        init: true,
        stop_timeout: Some(30),
        env: vec!["A=1".to_string()],
        ..Default::default()
    };
    assert_eq!(
        build_docker_runtime_args(&options)[..6],
        [
            "--privileged",
            "--init",
            "--stop-timeout",
            "30",
            "-e",
            "A=1"
        ]
    );
    let zero = IsolationOptions {
        stop_timeout: Some(0),
        ..Default::default()
    };
    assert_eq!(build_docker_runtime_args(&zero), ["--stop-timeout", "0"]);
    assert!(!build_docker_runtime_args(&IsolationOptions::default())
        .contains(&"--stop-timeout".to_string()));

    let parsed = parse_with_env(&["-i", "docker", "--stop-timeout", "30", "--", "ls"], None);
    let parsed = parsed.unwrap();
    assert!(docker_runtime_status_lines_for_options(&parsed)
        .contains(&"[Isolation] Stop timeout: 30s".to_string()));
    let opts_map = |options: &WrapperOptions| {
        build_isolation_options_map(
            Some("docker"),
            "detached",
            "box",
            Some("ubuntu:24.04"),
            options,
            None,
        )
    };
    let map = opts_map(&parsed);
    assert_eq!(map.get("stopTimeout"), Some(&json!(30)));
    let unset = parse_with_env(&["-i", "docker", "--", "ls"], None).unwrap();
    assert!(!opts_map(&unset).contains_key("stopTimeout"));
}

fn record(extra: &[(&str, serde_json::Value)]) -> ExecutionRecord {
    let mut record = ExecutionRecord::new("npm test");
    record.uuid = UUID.to_string();
    record.log_path = "/tmp/session-265.log".to_string();
    record.pid = Some(4242);
    for (key, value) in [
        ("isolated", json!("docker")),
        ("isolationMode", json!("detached")),
        ("sessionName", json!("box")),
        ("image", json!("ubuntu:24.04")),
    ] {
        record.options.insert(key.to_string(), value);
    }
    for (key, value) in extra {
        record.options.insert(key.to_string(), value.clone());
    }
    record
}

fn control(
    record: &ExecutionRecord,
    action: ControlAction,
    stop_timeout: Option<u64>,
    env_value: Option<&str>,
) -> Result<start_command::ControlCommand, String> {
    let env = env_with(env_value);
    get_control_command_with_options(
        record,
        action,
        &ControlOptions {
            stop_timeout,
            env: Some(&env),
        },
    )
}

#[test]
fn stop_passes_t_for_an_explicit_timeout_and_says_so() {
    let command = control(&record(&[]), ControlAction::Stop, Some(120), None).unwrap();
    assert_eq!(command.args, ["stop", "-t", "120", "box"]);
    assert_eq!(command.stop_timeout, Some(120));
    assert_eq!(
        command.message,
        "Requested graceful stop for detached docker container: box (SIGTERM, SIGKILL after 120s)"
    );
}

#[test]
fn stop_keeps_dockers_default_and_names_it() {
    let command = control(&record(&[]), ControlAction::Stop, None, None).unwrap();
    assert_eq!(command.args, ["stop", "box"]);
    assert_eq!(command.stop_timeout, Some(DOCKER_DEFAULT_STOP_TIMEOUT));
    assert!(command.message.ends_with("(SIGTERM, SIGKILL after 10s)"));
}

#[test]
fn stop_resolves_flag_then_launch_value_then_environment() {
    let recorded = record(&[("stopTimeout", json!(30))]);
    let env = env_with(Some("60"));
    let explicit = |seconds| StopTimeout {
        seconds,
        explicit: true,
    };
    assert_eq!(
        resolve_stop_timeout(&recorded, Some(5), &env),
        Ok(explicit(5))
    );
    assert_eq!(
        resolve_stop_timeout(&recorded, None, &env),
        Ok(explicit(30))
    );
    assert_eq!(
        resolve_stop_timeout(&record(&[]), None, &env),
        Ok(explicit(60))
    );
    assert_eq!(
        control(&recorded, ControlAction::Stop, None, None)
            .unwrap()
            .args,
        ["stop", "-t", "30", "box"]
    );
    assert_eq!(
        control(&record(&[]), ControlAction::Stop, None, Some("60"))
            .unwrap()
            .args,
        ["stop", "-t", "60", "box"]
    );
}

#[test]
fn stop_reports_an_invalid_environment_value() {
    let error = control(&record(&[]), ControlAction::Stop, None, Some("-1"))
        .err()
        .unwrap();
    assert!(error.contains("Invalid START_DOCKER_STOP_TIMEOUT value"));
}

#[test]
fn stop_timeout_is_rejected_for_screen_and_tmux() {
    for backend in ["screen", "tmux"] {
        let session = record(&[("isolated", json!(backend)), ("sessionName", json!("s"))]);
        let error = control(&session, ControlAction::Stop, Some(30), None)
            .err()
            .unwrap();
        assert_eq!(
            error,
            format!(
                "--stop-timeout is only supported for detached docker executions, not {}.",
                backend
            )
        );
    }
}

#[test]
fn terminate_is_unchanged() {
    let recorded = record(&[("stopTimeout", json!(30))]);
    let command = control(&recorded, ControlAction::Terminate, None, None).unwrap();
    assert_eq!(command.args, ["kill", "box"]);
    assert_eq!(command.stop_timeout, None);
}

#[derive(Default)]
struct Recorder(RefCell<Vec<(String, Vec<String>)>>);

impl CommandRunner for Recorder {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        self.0
            .borrow_mut()
            .push((command.to_string(), args.to_vec()));
        CommandRunOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
            status: Some(0),
            error: None,
        }
    }
}

#[test]
fn control_runs_docker_stop_t_and_prints_the_grace_period() {
    let dir = tempfile::tempdir().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    store.save(&record(&[])).unwrap();
    let runner = Recorder::default();
    let env = env_with(None);
    let result = control_execution_with_runner_and_options(
        Some(&store),
        UUID,
        ControlAction::Stop,
        &runner,
        &ControlOptions {
            stop_timeout: Some(45),
            env: Some(&env),
        },
    );
    assert!(result.success, "{:?}", result.error);
    assert_eq!(
        runner.0.borrow()[0],
        ("docker".to_string(), args(&["stop", "-t", "45", "box"]))
    );
    let output = result.output.unwrap();
    assert!(
        output.contains("  method DOCKER_STOP\n  stopTimeout 45"),
        "{}",
        output
    );
    assert!(output.contains(
        "Requested graceful stop for detached docker container: box (SIGTERM, SIGKILL after 45s)"
    ));
}

fn stopped() -> SessionProbe {
    SessionProbe {
        backend: Some("docker".to_string()),
        session_name: Some("box".to_string()),
        state: SessionState::Stopped,
        alive: false,
        container_status: Some("exited".to_string()),
    }
}

#[test]
fn resume_keeps_the_launch_grace_period() {
    let recorded = record(&[("stopTimeout", json!(30))]);
    assert_eq!(build_launch_options(&recorded).stop_timeout, Some(30));
    let plan = build_resume_plan(&recorded, Some("echo hi"), &stopped()).unwrap();
    assert!(plan.steps[1].args.join(" ").contains("--stop-timeout 30"));
    // Records from before #265 start without it.
    let plan = build_resume_plan(&record(&[]), Some("echo hi"), &stopped()).unwrap();
    assert!(!plan.steps[1].args.iter().any(|a| a == "--stop-timeout"));
}

// --- Real docker -------------------------------------------------------

const IMAGE: &str = "alpine:3.23";

fn docker(args: &[&str]) -> (i32, String) {
    let output = Command::new("docker").args(args).output();
    match output {
        Ok(out) => (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        ),
        Err(_) => (-1, String::new()),
    }
}

fn docker_ready() -> bool {
    docker(&["run", "--rm", IMAGE, "true"]).0 == 0
}

struct Home(tempfile::TempDir);

impl Home {
    fn new() -> Self {
        Home(tempfile::tempdir().unwrap())
    }
    fn cli(&self, cli_args: &[&str]) -> std::process::Output {
        let root = self.0.path();
        Command::new(env!("CARGO_BIN_EXE_start"))
            .args(cli_args)
            .env("HOME", root)
            .env("START_APP_FOLDER", root.join("app"))
            .env("START_LOG_DIR", root.join("logs"))
            .env("START_DISABLE_AUTO_ISSUE", "1")
            .env("START_DISABLE_LOG_UPLOAD", "1")
            .env("START_EXECUTION_ID", "")
            .env(DOCKER_STOP_TIMEOUT_ENV, "")
            .output()
            .unwrap()
    }
    fn launch(&self, name: &str, flags: &[&str], command: &str) {
        let mut cli_args = vec!["--isolated", "docker"];
        cli_args.extend_from_slice(flags);
        cli_args.extend_from_slice(&[
            "--detached",
            "--keep-container",
            "--image",
            IMAGE,
            "--session",
            name,
            "--",
            command,
        ]);
        let out = self.cli(&cli_args);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

struct Container(String);

impl Drop for Container {
    fn drop(&mut self) {
        docker(&["rm", "-f", &self.0]);
    }
}

fn wait_for_log(name: &str, text: &str) -> bool {
    let end = Instant::now() + Duration::from_secs(30);
    while Instant::now() < end {
        if docker(&["logs", name]).1.contains(text) {
            return true;
        }
        sleep(Duration::from_millis(200));
    }
    false
}

#[test]
fn real_docker_slow_sigterm_handler_finishes_within_the_launch_grace_period() {
    if !docker_ready() {
        eprintln!("Skipping: docker cannot run Linux images");
        return;
    }
    let home = Home::new();
    let name = Container(format!("r265-grace-{}", std::process::id()));
    // The handler needs ~2s; Docker's default would allow it, but the point
    // is that --stop honours the recorded value rather than its own default.
    home.launch(
        &name.0,
        &["--stop-timeout", "5"],
        "trap 'echo got-term; sleep 2; echo cleanup-done; exit 0' TERM; \
         echo ready; while true; do sleep 0.1; done",
    );
    assert_eq!(
        docker(&["inspect", "-f", "{{.Config.StopTimeout}}", &name.0]).1,
        "5"
    );
    assert!(wait_for_log(&name.0, "ready"));
    let stop = home.cli(&["--stop", &name.0]);
    let stdout = String::from_utf8_lossy(&stop.stdout);
    assert!(stop.status.success(), "{}", stdout);
    assert!(stdout.contains("stopTimeout 5"), "{}", stdout);
    assert!(stdout.contains("(SIGTERM, SIGKILL after 5s)"), "{}", stdout);
    assert_eq!(
        docker(&["inspect", "-f", "{{.State.ExitCode}}", &name.0]).1,
        "0"
    );
    assert!(docker(&["logs", &name.0]).1.contains("cleanup-done"));
}

#[test]
fn real_docker_stop_timeout_flag_kills_after_the_shorter_period() {
    if !docker_ready() {
        eprintln!("Skipping: docker cannot run Linux images");
        return;
    }
    let home = Home::new();
    let name = Container(format!("r265-short-{}", std::process::id()));
    home.launch(
        &name.0,
        &[],
        "trap 'echo got-term; sleep 5; echo cleanup-done; exit 0' TERM; \
         echo ready; while true; do sleep 0.1; done",
    );
    assert!(wait_for_log(&name.0, "ready"));
    let started = Instant::now();
    let stop = home.cli(&["--stop", &name.0, "--stop-timeout", "1"]);
    let elapsed = started.elapsed();
    let stdout = String::from_utf8_lossy(&stop.stdout);
    assert!(stop.status.success(), "{}", stdout);
    assert!(stdout.contains("(SIGTERM, SIGKILL after 1s)"), "{}", stdout);
    // Well under Docker's 10s default.
    assert!(elapsed < Duration::from_secs(8), "{:?}", elapsed);
    assert_eq!(
        docker(&["inspect", "-f", "{{.State.ExitCode}}", &name.0]).1,
        "137"
    );
    assert!(!docker(&["logs", &name.0]).1.contains("cleanup-done"));
}
