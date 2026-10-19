//! Issue #230: every backend exports START_EXECUTION_ID, START_SESSION_NAME and
//! START_ATTEMPT to the command it runs, so a supervisor can recognise its
//! own executions without parsing the start block. Mirrors
//! js/test/regression-230.js.

#![cfg(unix)]

use start_command::docker_command_handoff::{
    build_command_handoff_args, write_execution_env_handoff,
};
use start_command::execution_attempt::next_attempt_number;
use start_command::execution_control::{CommandRunOutput, CommandRunner};
use start_command::execution_env::{
    build_execution_env, build_execution_env_export, execution_env_from_options,
    is_nested_launch_of, prefix_with_execution_env,
};
use start_command::execution_store::ExecutionRecord;
use start_command::isolation::{build_docker_runtime_args, IsolationOptions};
use start_command::launch_identity::{isolated_user_command, LaunchPlan};
use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

const UUID: &str = "23000000-0000-4000-8000-000000000230";
const PRINT: &str = "echo \"ID=$START_EXECUTION_ID S=$START_SESSION_NAME A=$START_ATTEMPT\"";

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn sh(script: &str) -> String {
    let output = Command::new("sh").args(["-c", script]).output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn run(args: &[&str]) -> Output {
    run_in(tempfile::tempdir().unwrap().path(), args)
}

/// Like `run`, with the store and logs under `root`, so a detached session
/// can keep writing after the launch returns.
fn run_in(root: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_start"))
        .args(args)
        .env("START_APP_FOLDER", root.join("app"))
        .env("START_LOG_DIR", root.join("logs"))
        .env("START_DISABLE_AUTO_ISSUE", "1")
        .env("START_DISABLE_LOG_UPLOAD", "1")
        .env_remove("START_EXECUTION_ID")
        .env_remove("START_ATTEMPT")
        .stdin(Stdio::null())
        .output()
        .expect("failed to run the start binary")
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).to_string()
}

fn has_command(name: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {}", name)])
        .output()
        .is_ok_and(|o| o.status.success())
}

#[test]
fn builds_the_three_variables_attempt_1_by_default() {
    assert_eq!(
        build_execution_env(Some(UUID), Some("s"), 1),
        pairs(&[
            ("START_EXECUTION_ID", UUID),
            ("START_SESSION_NAME", "s"),
            ("START_ATTEMPT", "1"),
        ])
    );
    assert!(build_execution_env(None, None, 1).is_empty());
    let options = IsolationOptions {
        uuid: Some(UUID.into()),
        session: Some("tmux-1".into()),
        attempt_number: 4,
        ..Default::default()
    };
    let env = execution_env_from_options(&options);
    assert_eq!(env[1], ("START_SESSION_NAME".into(), "tmux-1".into()));
    assert_eq!(env[2], ("START_ATTEMPT".into(), "4".into()));
}

#[test]
fn quotes_the_export_prefix_used_by_screen_tmux_and_ssh() {
    let env = build_execution_env(Some(UUID), Some("it's"), 2);
    assert_eq!(
        build_execution_env_export(&env),
        format!(
            "export START_EXECUTION_ID='{}' START_SESSION_NAME='it'\\''s' START_ATTEMPT='2'",
            UUID
        )
    );
    assert_eq!(
        sh(&prefix_with_execution_env(PRINT, &env)),
        format!("ID={} S=it's A=2", UUID)
    );
}

#[test]
fn passes_them_to_docker_run_after_the_user_env_so_they_win() {
    let options = IsolationOptions {
        env: vec!["START_EXECUTION_ID=spoofed".into()],
        uuid: Some(UUID.into()),
        session: Some("box".into()),
        attempt_number: 3,
        ..Default::default()
    };
    let args = build_docker_runtime_args(&options);
    let envs: Vec<&str> = args
        .windows(2)
        .filter(|pair| pair[0] == "-e")
        .map(|pair| pair[1].as_str())
        .collect();
    assert_eq!(
        envs,
        vec![
            "START_EXECUTION_ID=spoofed".to_string(),
            format!("START_EXECUTION_ID={}", UUID),
            "START_SESSION_NAME=box".to_string(),
            "START_ATTEMPT=3".to_string(),
        ]
    );
}

/// Records `docker cp` calls and copies the source file to `target`.
struct CopyRunner {
    target: PathBuf,
    calls: RefCell<Vec<Vec<String>>>,
}

impl CommandRunner for CopyRunner {
    fn run(&self, _command: &str, args: &[String]) -> CommandRunOutput {
        fs::copy(&args[1], &self.target).unwrap();
        self.calls.borrow_mut().push(args.to_vec());
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
fn the_docker_handoff_selector_sources_the_next_attempt_variables() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("marker");
    let runner = CopyRunner {
        target: dir.path().join("marker.env"),
        calls: RefCell::new(Vec::new()),
    };
    write_execution_env_handoff(
        "box",
        &build_execution_env(Some(UUID), Some("box"), 2),
        &runner,
    )
    .unwrap();
    assert_eq!(
        runner.calls.borrow()[0][2],
        "box:/.start-command-resume-box.env"
    );

    let main: Vec<String> = ["sh", "-c", PRINT].iter().map(|s| s.to_string()).collect();
    let args = build_command_handoff_args(&main, &marker.to_string_lossy());
    let output = Command::new(&args[0])
        .args(&args[1..])
        .env("START_ATTEMPT", "1")
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        format!("ID={} S=box A=2", UUID)
    );
}

#[test]
fn numbers_the_next_attempt_after_resumes_and_recoveries() {
    let mut record = ExecutionRecord::new("x");
    assert_eq!(next_attempt_number(&record), 2);
    record
        .options
        .insert("resumeCount".into(), serde_json::json!(1));
    assert_eq!(next_attempt_number(&record), 3);
}

#[test]
fn recognises_the_next_level_of_a_stacked_isolation() {
    assert!(is_nested_launch_of(UUID, Some(UUID)));
    assert!(!is_nested_launch_of(UUID, Some("other")));
    assert!(!is_nested_launch_of(UUID, None));
}

#[test]
fn isolated_user_command_exports_an_empty_session_name() {
    let launch = LaunchPlan {
        attempt_number: 2,
        ..LaunchPlan::fresh(PathBuf::from("/nonexistent"))
    };
    let command = isolated_user_command(PRINT, UUID, &launch);
    assert!(command.starts_with("export START_EXECUTION_ID="));
    assert_eq!(sh(&command), format!("ID={} S= A=2", UUID));
}

#[test]
fn session_id_x_sh_c_echo_start_execution_id_prints_x() {
    let result = run(&[
        "--session-id",
        UUID,
        "--",
        "sh",
        "-c",
        "echo $START_EXECUTION_ID",
    ]);
    assert_eq!(result.status.code(), Some(0));
    assert!(stdout(&result).contains(&format!("\n{}\n", UUID)));
}

#[test]
fn a_direct_run_exports_an_empty_session_name_and_attempt_1() {
    let result = run(&["--session-id", UUID, "--", "sh", "-c", PRINT]);
    assert!(stdout(&result).contains(&format!("ID={} S= A=1", UUID)));
}

#[test]
fn a_generated_execution_id_is_exported_too() {
    let result = run(&["--", "sh", "-c", PRINT]);
    let out = stdout(&result);
    let line = out
        .lines()
        .find(|l| l.starts_with("ID=") && l.ends_with(" S= A=1"))
        .unwrap_or_else(|| panic!("no identity line in {}", out));
    let id = &line[3..39];
    assert_eq!(id.len(), 36);
    assert!(out.matches(id).count() >= 2, "{}", out);
}

#[test]
fn screen_exports_them_with_the_session_name() {
    if !has_command("screen") {
        return;
    }
    let session = format!("start-230-rs-{}", std::process::id());
    let result = run(&[
        "-i",
        "screen",
        "--session",
        &session,
        "--session-id",
        UUID,
        "--",
        "sh",
        "-c",
        PRINT,
    ]);
    assert!(
        stdout(&result).contains(&format!("ID={} S={} A=1", UUID, session)),
        "{}",
        stdout(&result)
    );
}

/// Attached tmux needs a terminal, which CI and test runners do not have, so
/// this runs detached and reads the command output from the log.
#[test]
fn tmux_exports_them_with_the_session_name() {
    if !has_command("tmux") {
        return;
    }
    let session = format!("start-230-rs-tmux-{}", std::process::id());
    let root = tempfile::tempdir().unwrap();
    let result = run_in(
        root.path(),
        &[
            "-i",
            "tmux",
            "--detached",
            "--session",
            &session,
            "--session-id",
            UUID,
            "--",
            "sh",
            "-c",
            PRINT,
        ],
    );
    let out = stdout(&result);
    assert_eq!(result.status.code(), Some(0), "{}", out);
    let log_path = out
        .lines()
        .find_map(|line| line.strip_prefix("│ log"))
        .unwrap_or_else(|| panic!("no log line in {}", out))
        .trim()
        .to_string();
    let expected = format!("ID={} S={} A=1", UUID, session);
    let mut log = String::new();
    for _ in 0..100 {
        log = fs::read_to_string(&log_path).unwrap_or_default();
        if log.contains(&expected) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = Command::new("tmux")
        .args(["kill-session", "-t", &session])
        .output();
    assert!(log.contains(&expected), "{}", log);
}
