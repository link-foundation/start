//! Regression tests for issue #244: `--init` / `--no-init` run Docker's
//! bundled tini as PID 1, so orphaned processes of a long-running task are
//! reaped instead of piling up as zombies. The default stays off;
//! START_COMMAND_DOCKER_INIT=1 turns it on per host. The flag is stored with
//! the record, carried into resumes, and changes neither exit codes nor OOM
//! evidence.

use serde_json::json;
use start_command::docker_init_option::{
    docker_init_from_env_value, validate_with_env, DOCKER_INIT_ENV,
};
use start_command::execution_resume::{build_launch_options, build_resume_plan};
use start_command::isolation::build_docker_runtime_args;
use start_command::isolation_metadata::{
    build_isolation_options_map, docker_runtime_status_lines_for_options,
};
use start_command::output_blocks::{generate_isolation_lines, parse_isolation_metadata};
use start_command::{
    parse_args, validate_options, ExecutionRecord, IsolationOptions, SessionProbe, SessionState,
    WrapperOptions,
};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

fn args(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// Parse, then resolve `init` against an explicit environment value.
fn parse_with_env(items: &[&str], env_value: Option<&str>) -> Result<WrapperOptions, String> {
    let mut options = parse_args(&args(items))?.wrapper_options;
    // parse_args resolved against the real environment; start over.
    if !items.contains(&"--init") && !items.contains(&"--no-init") {
        options.init = None;
    }
    let value = env_value.map(str::to_string);
    validate_with_env(&mut options, &|name| {
        assert_eq!(name, DOCKER_INIT_ENV);
        value.clone()
    })?;
    Ok(options)
}

#[test]
fn init_and_no_init_flags() {
    let on = parse_with_env(&["-i", "docker", "--init", "--", "ls"], None).unwrap();
    assert_eq!(on.init, Some(true));
    let off = parse_with_env(&["-i", "docker", "--no-init", "--", "ls"], None).unwrap();
    assert_eq!(off.init, Some(false));
}

#[test]
fn init_defaults_to_off() {
    let docker = parse_with_env(&["-i", "docker", "--", "ls"], None).unwrap();
    assert_eq!(docker.init, Some(false));
    let plain = parse_with_env(&["--", "ls"], None).unwrap();
    assert_eq!(plain.init, Some(false));
}

#[test]
fn environment_default_and_no_init_override() {
    for value in ["1", "true", "YES", " on "] {
        let options = parse_with_env(&["-i", "docker", "--", "ls"], Some(value)).unwrap();
        assert_eq!(options.init, Some(true), "{:?}", value);
    }
    for value in ["0", "false", "off", ""] {
        let options = parse_with_env(&["-i", "docker", "--", "ls"], Some(value)).unwrap();
        assert_eq!(options.init, Some(false), "{:?}", value);
    }
    let overridden = parse_with_env(&["-i", "docker", "--no-init", "--", "ls"], Some("1")).unwrap();
    assert_eq!(overridden.init, Some(false));
    assert!(docker_init_from_env_value(Some("True")));
    assert!(!docker_init_from_env_value(None));
}

#[test]
fn environment_default_is_ignored_without_docker() {
    let plain = parse_with_env(&["--", "ls"], Some("1")).unwrap();
    assert_eq!(plain.init, Some(false));
    let screen = parse_with_env(&["-i", "screen", "-d", "--", "ls"], Some("1")).unwrap();
    assert_eq!(screen.init, Some(false));
}

#[test]
fn init_is_rejected_without_docker_and_no_init_accepted() {
    for items in [
        &["--init", "--", "ls"][..],
        &["-i", "screen", "-d", "--init", "--", "ls"][..],
    ] {
        let err = parse_args(&args(items)).unwrap_err();
        assert!(
            err.contains("--init option is only valid with --isolated docker"),
            "{}",
            err
        );
    }
    let options = parse_args(&args(&["--no-init", "--", "ls"]))
        .unwrap()
        .wrapper_options;
    assert_eq!(options.init, Some(false));
}

#[test]
fn validating_again_keeps_the_result() {
    for items in [
        &["--", "ls"][..],
        &["-i", "docker", "--", "ls"][..],
        &["-i", "docker", "--no-init", "--", "ls"][..],
        &["-i", "docker", "--init", "--", "ls"][..],
    ] {
        let mut options = parse_with_env(items, Some("1")).unwrap();
        let before = options.init;
        validate_options(&mut options).unwrap();
        assert_eq!(options.init, before, "{:?}", items);
    }
}

#[test]
fn docker_run_puts_init_after_privileged() {
    let both = IsolationOptions {
        privileged: true,
        init: true,
        env: vec!["A=1".to_string()],
        ..Default::default()
    };
    assert_eq!(
        build_docker_runtime_args(&both)[..4],
        ["--privileged", "--init", "-e", "A=1"]
    );
    let init_only = IsolationOptions {
        init: true,
        ..Default::default()
    };
    assert_eq!(build_docker_runtime_args(&init_only)[0], "--init");
    assert!(!build_docker_runtime_args(&IsolationOptions::default()).contains(&"--init".into()));
}

#[test]
fn status_line_record_metadata_and_start_block_row() {
    let mut options = parse_with_env(
        &[
            "-i",
            "docker",
            "--privileged",
            "--init",
            "--network",
            "n1",
            "--",
            "ls",
        ],
        None,
    )
    .unwrap();
    let lines = docker_runtime_status_lines_for_options(&options);
    let init_at = lines.iter().position(|l| l == "[Isolation] Init: true");
    let privileged_at = lines
        .iter()
        .position(|l| l == "[Isolation] Privileged: true");
    let network_at = lines
        .iter()
        .position(|l| l.starts_with("[Isolation] Network"));
    assert!(
        privileged_at < init_at && init_at < network_at,
        "{:?}",
        lines
    );

    let map = build_isolation_options_map(
        Some("docker"),
        "detached",
        "box",
        Some("alpine:3.23"),
        &options,
        None,
    );
    assert_eq!(map.get("init"), Some(&json!(true)));
    options.init = Some(false);
    assert!(!docker_runtime_status_lines_for_options(&options)
        .iter()
        .any(|l| l.contains("Init")));
    let map = build_isolation_options_map(Some("docker"), "detached", "box", None, &options, None);
    assert!(!map.contains_key("init"));

    let metadata = parse_isolation_metadata(&[
        "[Isolation] Environment: docker, Mode: detached",
        "[Isolation] Image: alpine:3.23",
        "[Isolation] Init: true",
        "[Isolation] User: box (isolated)",
    ]);
    assert!(metadata.init);
    let block = generate_isolation_lines(&metadata, Some("box")).join("\n");
    let init = block.find("init").expect("init row");
    assert!(init < block.find("user").unwrap(), "{}", block);
    let off = parse_isolation_metadata(&["[Isolation] Environment: docker, Mode: detached"]);
    assert!(!generate_isolation_lines(&off, Some("box"))
        .join("\n")
        .contains("init"));
}

fn record(init: Option<bool>) -> ExecutionRecord {
    let mut record = ExecutionRecord::new("npm test");
    record.uuid = "24400000-0000-4000-8000-000000000244".to_string();
    record.log_path = "/tmp/session.log".to_string();
    for (key, value) in [
        ("isolated", json!("docker")),
        ("isolationMode", json!("detached")),
        ("sessionName", json!("box")),
        ("image", json!("ubuntu:24.04")),
    ] {
        record.options.insert(key.to_string(), value);
    }
    if let Some(init) = init {
        record.options.insert("init".to_string(), json!(init));
    }
    record
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
fn resume_keeps_the_stored_choice() {
    assert!(build_launch_options(&record(Some(true))).init);
    assert!(!build_launch_options(&record(None)).init);
    let plan = build_resume_plan(&record(Some(true)), Some("echo hi"), &stopped()).unwrap();
    assert!(plan.steps[1].args.iter().any(|a| a == "--init"));
    // Records from before #244 start without it.
    let plan = build_resume_plan(&record(None), Some("echo hi"), &stopped()).unwrap();
    assert!(!plan.steps[1].args.iter().any(|a| a == "--init"));
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
            .env(DOCKER_INIT_ENV, "")
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
    fn status(&self, name: &str) -> String {
        let out = self.cli(&["--status", name, "--output-format", "json"]);
        String::from_utf8_lossy(&out.stdout).to_string()
    }
}

struct Containers(Vec<String>);

impl Drop for Containers {
    fn drop(&mut self) {
        let mut rm = vec!["rm", "-f"];
        rm.extend(self.0.iter().map(String::as_str));
        docker(&rm);
    }
}

fn wait_until<T>(timeout: Duration, mut check: impl FnMut() -> Option<T>) -> Option<T> {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if let Some(value) = check() {
            return Some(value);
        }
        sleep(Duration::from_millis(200));
    }
    None
}

#[test]
fn real_docker_init_is_pid_1_reaps_orphans_and_is_recorded() {
    if !docker_ready() {
        eprintln!("Skipping: docker cannot run Linux images");
        return;
    }
    let home = Home::new();
    let pid = std::process::id();
    let names = Containers(vec![
        format!("r244-init-{}", pid),
        format!("r244-plain-{}", pid),
    ]);
    // The subshell exits at once; its `sleep 0.2` child becomes an orphan of
    // PID 1 and exits 0.2 s later.
    home.launch(&names.0[0], &["--init"], "(sleep 0.2 &) ; sleep 30");
    home.launch(&names.0[1], &[], "(sleep 0.2 &) ; sleep 30");
    sleep(Duration::from_millis(1500));
    let probe = |name: &str| {
        (
            docker(&["inspect", "-f", "{{.HostConfig.Init}}", name]).1,
            docker(&["exec", name, "cat", "/proc/1/comm"]).1,
            docker(&[
                "exec",
                name,
                "sh",
                "-c",
                "grep -l '^State:.*Z' /proc/[0-9]*/status 2>/dev/null | wc -l",
            ])
            .1,
        )
    };
    let (init, pid1, zombies) = probe(&names.0[0]);
    assert_eq!(
        (init.as_str(), pid1.as_str(), zombies.as_str()),
        ("true", "docker-init", "0")
    );
    let (init, pid1, zombies) = probe(&names.0[1]);
    // Unset, Docker reports `<nil>` (no --init flag on the run).
    assert!(init == "false" || init == "<nil>", "{}", init);
    assert_ne!(pid1, "docker-init");
    assert_eq!(zombies, "1");

    let with_init: serde_json::Value = serde_json::from_str(&home.status(&names.0[0])).unwrap();
    assert_eq!(with_init["options"]["init"], json!(true), "{}", with_init);
    let without: serde_json::Value = serde_json::from_str(&home.status(&names.0[1])).unwrap();
    assert_ne!(without["options"]["init"], json!(true), "{}", without);
}

#[test]
fn real_docker_exit_codes_are_the_same_with_and_without_init() {
    if !docker_ready() {
        eprintln!("Skipping: docker cannot run Linux images");
        return;
    }
    let home = Home::new();
    let pid = std::process::id();
    let mut names = Containers(Vec::new());
    for (label, command, expected) in [
        ("exit3", "exit 3", 3),
        ("segv", "sh -c \"kill -SEGV \\$\\$\"; exit $?", 139),
    ] {
        for flags in [&["--init"][..], &[][..]] {
            let name = format!("r244-{}-{}-{}", label, flags.len(), pid);
            names.0.push(name.clone());
            home.launch(&name, flags, command);
            let code = wait_until(Duration::from_secs(30), || {
                let (_, out) = docker(&[
                    "inspect",
                    "-f",
                    "{{.State.Status}} {{.State.ExitCode}}",
                    &name,
                ]);
                let (state, code) = out.split_once(' ')?;
                (state == "exited")
                    .then(|| code.parse::<i32>().ok())
                    .flatten()
            });
            assert_eq!(code, Some(expected), "{} {:?}", label, flags);
            let recorded = wait_until(Duration::from_secs(30), || {
                let status: serde_json::Value = serde_json::from_str(&home.status(&name)).ok()?;
                (status["exitCode"] == json!(expected)).then_some(())
            });
            assert!(
                recorded.is_some(),
                "{} {:?}: {}",
                label,
                flags,
                home.status(&name)
            );
        }
    }
}

#[test]
fn real_docker_kill_is_137_either_way_and_stop_is_143_under_init() {
    if !docker_ready() {
        eprintln!("Skipping: docker cannot run Linux images");
        return;
    }
    let pid = std::process::id();
    let names = Containers(vec![format!("r244-k1-{}", pid), format!("r244-k0-{}", pid)]);
    let mut results = Vec::new();
    for (name, init) in [(&names.0[0], true), (&names.0[1], false)] {
        let mut run = vec!["run", "-d", "--name", name.as_str()];
        if init {
            run.push("--init");
        }
        run.extend_from_slice(&[IMAGE, "sleep", "30"]);
        assert_eq!(docker(&run).0, 0);
        docker(&["stop", "-t", "2", name]);
        let stopped = docker(&["inspect", "-f", "{{.State.ExitCode}}", name]).1;
        docker(&["start", name]);
        docker(&["kill", name]);
        docker(&["wait", name]);
        let killed = docker(&["inspect", "-f", "{{.State.ExitCode}}", name]).1;
        results.push((init, stopped, killed));
    }
    assert_eq!(
        results,
        vec![
            (true, "143".to_string(), "137".to_string()),
            (false, "137".to_string(), "137".to_string()),
        ]
    );
}
