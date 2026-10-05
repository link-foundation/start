//! Regression tests for issue #176, part 2: `--on-kill-resume N
//! --recovery-command B` resumes a detached docker session whose main process
//! was killed (exit 137 / OOMKilled) in the same container, under the same
//! execution UUID and log, up to N times. Part 1 (limits on snapshot resume,
//! option parsing) is in `regression_176.rs`.

use serde_json::{json, Value};
#[cfg(unix)]
use start_command::execution_recovery::RECOVERY_ATTEMPT_ENV;
use start_command::execution_recovery::{
    build_recovery_selector_args, format_recovery_separator, is_killed_exit,
    recover_killed_execution, recovery_selector, RecoveryFacts, RecoveryOutcome, RecoverySeparator,
    RECOVERY_MARKER_PATH,
};
use start_command::{
    control_execution_with_runner, ControlAction, DockerWatcherOptions, ExecutionRecord,
    ExecutionStatus, ExecutionStore,
};
use std::cell::RefCell;
use std::path::PathBuf;
use tempfile::TempDir;
#[path = "support/issue_176.rs"]
mod support;
use support::*;

// ---------------------------------------------------------------------------
// Gap 2: recovery selector inside the container
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn run_selector(marker_content: Option<&str>) -> String {
    let temp = TempDir::new().unwrap();
    let marker = temp.path().join("marker");
    if let Some(content) = marker_content {
        std::fs::write(&marker, content).unwrap();
    }
    let mut selector_args = build_recovery_selector_args(
        &args(&["sh", "-c", "echo main"]),
        "sh",
        None,
        &format!("echo \"recovery ${}\"", RECOVERY_ATTEMPT_ENV),
    );
    // Point the selector at a temp marker instead of `/` of a container.
    selector_args[2] = selector_args[2].replace(RECOVERY_MARKER_PATH, &marker.to_string_lossy());
    let output = std::process::Command::new(&selector_args[0])
        .args(&selector_args[1..])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[cfg(unix)]
#[test]
fn runs_the_main_command_until_a_recovery_is_marked() {
    assert_eq!(run_selector(None), "main");
    assert_eq!(run_selector(Some("2\n")), "recovery 2");
}

#[test]
fn wraps_the_main_argv_after_the_recovery_parameters() {
    assert_eq!(
        build_recovery_selector_args(&args(&["bash", "-c", "a"]), "bash", Some("-l"), "b"),
        vec![
            "sh".to_string(),
            "-c".to_string(),
            recovery_selector(),
            "start-command".to_string(),
            "bash".to_string(),
            "-l".to_string(),
            "b".to_string(),
            "bash".to_string(),
            "-c".to_string(),
            "a".to_string(),
        ]
    );
}

// ---------------------------------------------------------------------------
// Gap 2: resuming a killed session
// ---------------------------------------------------------------------------

/// `(container, uuid, since, recover_on_kill)` of a started watcher.
type WatcherCall = (String, String, Option<String>, bool);

struct RecoveryFixture {
    _temp: TempDir,
    store: ExecutionStore,
    record: ExecutionRecord,
    log_path: PathBuf,
}

impl RecoveryFixture {
    fn new(extra: Value) -> Self {
        let temp = TempDir::new().unwrap();
        let store = test_store(&temp.path().join("app"));
        let log_path = temp.path().join("run.log");
        std::fs::write(&log_path, "main output\n").unwrap();
        let mut options = json!({ "onKillResume": 2, "recoveryCommand": "solve --resume" });
        for (key, value) in extra.as_object().unwrap() {
            options[key] = value.clone();
        }
        let record = docker_record(ExecutionStatus::Executing, Some(&log_path), options);
        store.save(&record).unwrap();
        RecoveryFixture {
            _temp: temp,
            store,
            record,
            log_path,
        }
    }

    fn log(&self) -> String {
        std::fs::read_to_string(&self.log_path).unwrap()
    }

    fn stored(&self) -> ExecutionRecord {
        self.store.get(&self.record.uuid).unwrap()
    }

    fn recover(
        &self,
        runner: &FakeRunner,
        facts: RecoveryFacts,
    ) -> (RecoveryOutcome, Vec<WatcherCall>) {
        let watchers = RefCell::new(Vec::new());
        let outcome = recover_killed_execution(
            &self.store,
            &self.record.uuid,
            &facts,
            runner,
            &|name: &str, record: &ExecutionRecord, options: &DockerWatcherOptions| {
                watchers.borrow_mut().push((
                    name.to_string(),
                    record.uuid.clone(),
                    options.since.clone(),
                    options.recover_on_kill,
                ));
            },
        );
        (outcome, watchers.into_inner())
    }
}

fn killed() -> RecoveryFacts {
    RecoveryFacts {
        exit_code: "137".to_string(),
        oom_killed: "true".to_string(),
        started_at: "2026-10-01T10:00:00Z".to_string(),
        finished_at: "2026-10-01T10:05:00Z".to_string(),
        container_error: String::new(),
        ..Default::default()
    }
}

#[test]
fn detects_a_kill_by_exit_137_or_oom_killed_without_an_exit_code() {
    assert!(is_killed_exit("137", "false"));
    assert!(is_killed_exit("-1", "true"));
    assert!(!is_killed_exit("1", "false"));
    assert!(!is_killed_exit("", ""));
}

#[test]
fn formats_the_recovery_separator() {
    assert_eq!(
        format_recovery_separator(&RecoverySeparator {
            attempt: 1,
            max_attempts: 3,
            exit_code: "137",
            oom_killed: "true",
            container_name: "box",
            command: Some("solve --resume"),
            delay_ms: 0,
        }),
        "\n[Recovery 1/3] Main process was killed (exit 137, SIGKILL, oomKilled=true); resuming container box, running recovery command: solve --resume\n"
    );
}

#[test]
fn marks_the_container_restarts_it_and_keeps_the_same_uuid_and_log() {
    let fixture = RecoveryFixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config());
    let (outcome, watchers) = fixture.recover(&runner, killed());
    assert_eq!(
        outcome,
        RecoveryOutcome {
            recovered: true,
            reason: "resumed".to_string(),
            attempt: Some(1),
            delay_ms: None,
        }
    );

    let cp = runner.call("cp").expect("docker cp");
    assert_eq!(cp[3], format!("box:{}", RECOVERY_MARKER_PATH));
    let verbs = runner.verbs();
    let cp_index = verbs.iter().position(|verb| verb == "cp").unwrap();
    let start_index = verbs.iter().position(|verb| verb == "start").unwrap();
    assert!(cp_index < start_index);
    assert_eq!(runner.call("start").unwrap()[1..], ["start", "box"]);

    let log = fixture.log();
    assert!(log.starts_with("main output\n"));
    assert!(log.contains("[Recovery 1/2] Main process was killed (exit 137"));
    assert!(log.contains("running recovery command: solve --resume"));
    assert!(log.contains(
        "[Isolation] Resource limits: --memory=256m --memory-swap=256m --cpus=0.5 --pids-limit=64"
    ));

    let updated = fixture.stored();
    assert_eq!(updated.uuid, fixture.record.uuid);
    assert_eq!(updated.status, ExecutionStatus::Executing);
    assert_eq!(updated.options["recoveryAttempts"], json!(1));
    let history = updated.options["recoveryHistory"].as_array().unwrap();
    assert_eq!(history.len(), 1);
    assert!(history[0]
        .as_str()
        .unwrap()
        .starts_with("1: exit 137, oomKilled=true, resumed at "));
    assert_eq!(updated.options["resourceLimits"], json!(ISSUE_LIMITS));

    assert_eq!(watchers.len(), 1);
    let (name, uuid, since, recover_on_kill) = &watchers[0];
    assert_eq!(name, "box");
    assert_eq!(uuid, &fixture.record.uuid);
    assert_eq!(
        since.as_ref(),
        updated.options["lastRecoveryAt"]
            .as_str()
            .map(str::to_string)
            .as_ref()
    );
    assert!(recover_on_kill);
}

#[test]
fn re_runs_the_original_command_when_no_recovery_command_is_set() {
    let fixture = RecoveryFixture::new(json!({ "recoveryCommand": null }));
    let runner = FakeRunner::new(updated_host_config());
    let (outcome, _) = fixture.recover(&runner, killed());
    assert!(outcome.recovered);
    assert!(runner.call("cp").is_none());
    assert!(fixture.log().contains("running the original command again"));
}

#[test]
fn stops_after_n_attempts() {
    let fixture = RecoveryFixture::new(json!({ "recoveryAttempts": 2 }));
    let runner = FakeRunner::new(updated_host_config());
    let (outcome, watchers) = fixture.recover(&runner, killed());
    assert_eq!(outcome.reason, "attempts-exhausted");
    assert!(!outcome.recovered);
    assert!(runner.calls().is_empty());
    assert!(watchers.is_empty());
    assert!(fixture
        .log()
        .contains("[Recovery] Not resuming: all 2 recovery attempt(s) used."));
}

#[test]
fn does_not_undo_a_deliberate_stop() {
    let fixture = RecoveryFixture::new(json!({ "stopRequestedAt": "2026-10-01T10:04:00Z" }));
    let runner = FakeRunner::new(updated_host_config());
    assert_eq!(
        fixture.recover(&runner, killed()).0.reason,
        "stop-requested"
    );
    assert!(runner.calls().is_empty());
}

#[test]
fn ignores_ordinary_failures_and_sessions_without_recovery() {
    let fixture = RecoveryFixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config());
    let failed = RecoveryFacts {
        exit_code: "1".to_string(),
        oom_killed: "false".to_string(),
        ..killed()
    };
    assert_eq!(fixture.recover(&runner, failed).0.reason, "not-killed");
    let plain = RecoveryFixture::new(json!({ "onKillResume": null, "recoveryCommand": null }));
    assert_eq!(plain.recover(&runner, killed()).0.reason, "not-configured");
    assert!(runner.calls().is_empty());
}

#[test]
fn reports_a_failed_docker_start_in_the_log() {
    let fixture = RecoveryFixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config()).failing("start", "no such container");
    let (outcome, watchers) = fixture.recover(&runner, killed());
    assert_eq!(outcome.reason, "resume-failed");
    assert!(watchers.is_empty());
    assert!(fixture
        .log()
        .contains("[Recovery 1/2] Failed: docker start failed: no such container"));
    assert!(!fixture.stored().options.contains_key("recoveryAttempts"));
}

#[test]
fn marks_a_stop_so_the_watcher_does_not_resume_it() {
    let fixture = RecoveryFixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config());
    let result = control_execution_with_runner(
        Some(&fixture.store),
        &fixture.record.uuid,
        ControlAction::Stop,
        &runner,
    );
    assert!(result.success, "{:?}", result.error);
    assert!(fixture.stored().options.contains_key("stopRequestedAt"));

    let failed = RecoveryFixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config()).failing("stop", "boom");
    let result = control_execution_with_runner(
        Some(&failed.store),
        &failed.record.uuid,
        ControlAction::Stop,
        &runner,
    );
    assert!(!result.success);
    assert!(!failed.stored().options.contains_key("stopRequestedAt"));

    // Sessions without recovery are left untouched.
    let plain = RecoveryFixture::new(json!({ "onKillResume": null, "recoveryCommand": null }));
    let runner = FakeRunner::new(updated_host_config());
    control_execution_with_runner(
        Some(&plain.store),
        &plain.record.uuid,
        ControlAction::Stop,
        &runner,
    );
    assert!(!plain.stored().options.contains_key("stopRequestedAt"));
}

// ---------------------------------------------------------------------------
// Gap 2: the completion watcher hands kills to the recovery
// ---------------------------------------------------------------------------

#[test]
fn builds_the_recovery_branch_only_when_requested() {
    use start_command::{
        build_detached_docker_completion_script, build_detached_docker_completion_script_with,
        DockerContainerCleanupPolicy,
    };
    let log_path = PathBuf::from("/tmp/run.log");
    let plain = build_detached_docker_completion_script(
        "box",
        DockerContainerCleanupPolicy::Keep,
        Some(&log_path),
        Some("uuid-1"),
    );
    assert!(!plain.contains("--internal-recover-detached-docker"));
    let script = build_detached_docker_completion_script_with(
        "box",
        DockerContainerCleanupPolicy::Keep,
        Some(&log_path),
        Some("uuid-1"),
        &DockerWatcherOptions {
            since: Some("2026-10-01T10:05:01.000Z".to_string()),
            recover_on_kill: true,
        },
    );
    assert!(
        script.contains("--since '2026-10-01T10:05:01.000Z'"),
        "{}",
        script
    );
    assert!(script.contains("--internal-recover-detached-docker"));
    assert!(script.contains("= 137 ]"));
    // Recovery runs before the cleanup / footer / finalize branch.
    assert!(
        script.find("--internal-recover-detached-docker").unwrap()
            < script.find("--internal-finalize-detached-docker").unwrap()
    );
}

#[cfg(unix)]
mod shell {
    use super::*;
    use start_command::{
        build_detached_docker_completion_script_with, DockerContainerCleanupPolicy,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    const KILLED: &str = "137 true 2026-10-01T10:00:00.000000000Z 2026-10-01T10:05:00.000000000Z";
    const FAILED: &str = "1 false 2026-10-01T10:00:00.000000000Z 2026-10-01T10:05:00.000000000Z";

    struct WatcherRun {
        calls: String,
        log: String,
        record: ExecutionRecord,
    }

    /// Run the real watcher against a fake docker that reports `state`.
    fn run_watcher(state: &str, extra: Value) -> WatcherRun {
        let temp = TempDir::new().unwrap();
        let dir = temp.path();
        let bin_dir = dir.join("bin");
        let app_folder = dir.join("app");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let log_path = dir.join("run.log");
        let docker_path = bin_dir.join("docker");
        std::fs::write(
            &docker_path,
            [
                "#!/bin/sh".to_string(),
                format!("dir='{}'", dir.display()),
                "echo \"$*\" >> \"$dir/calls\"".to_string(),
                "case \"$1\" in".to_string(),
                "  inspect)".to_string(),
                "    case \"$3\" in".to_string(),
                "      *State.Running*) echo false ;;".to_string(),
                "      *State.Error*) echo \"\" ;;".to_string(),
                "      *HostConfig*) echo \"{}\" ;;".to_string(),
                format!("      *) echo '{}' ;;", state),
                "    esac ;;".to_string(),
                "  logs) echo work ;;".to_string(),
                "  wait) echo 137 ;;".to_string(),
                "esac".to_string(),
                String::new(),
            ]
            .join("\n"),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&docker_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&docker_path, permissions).unwrap();

        let store = test_store(&app_folder);
        let mut options = json!({ "onKillResume": 1 });
        for (key, value) in extra.as_object().unwrap() {
            options[key] = value.clone();
        }
        let mut record = docker_record(ExecutionStatus::Executing, Some(&log_path), options);
        record.command = "solve".to_string();
        store.save(&record).unwrap();

        let script = build_detached_docker_completion_script_with(
            "box",
            DockerContainerCleanupPolicy::Keep,
            Some(&log_path),
            Some(&record.uuid),
            &DockerWatcherOptions {
                since: None,
                recover_on_kill: true,
            },
        );
        // The watcher re-invokes the running executable, which here is the
        // test harness; point it at the real `start` binary instead.
        let current_exe = std::env::current_exe().unwrap();
        let script = script.replace(
            current_exe.to_string_lossy().as_ref(),
            env!("CARGO_BIN_EXE_start"),
        );
        let path = std::env::var("PATH").unwrap_or_default();
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .env("PATH", format!("{}:{}", bin_dir.display(), path))
            .env("START_APP_FOLDER", &app_folder)
            .env_remove("START_DISABLE_TRACKING")
            .output()
            .expect("sh");
        assert!(output.status.success(), "watcher failed: {:?}", output);

        WatcherRun {
            calls: std::fs::read_to_string(dir.join("calls")).unwrap_or_default(),
            log: std::fs::read_to_string(&log_path).unwrap_or_default(),
            record: test_store(&app_folder).get(&record.uuid).unwrap(),
        }
    }

    #[test]
    fn finalizes_an_ordinary_failure_without_resuming() {
        let run = run_watcher(FAILED, json!({}));
        assert!(!run.calls.contains("start box"), "{}", run.calls);
        assert!(!run.log.contains("[Recovery"), "{}", run.log);
        assert_eq!(run.record.status, ExecutionStatus::Executed);
        assert_eq!(run.record.exit_code, Some(1));
    }

    #[test]
    fn finalizes_a_stopped_session_instead_of_resuming_it() {
        let run = run_watcher(KILLED, json!({ "stopRequestedAt": "2026-10-01T10:04:00Z" }));
        assert!(!run.calls.contains("start box"), "{}", run.calls);
        assert!(run
            .log
            .contains("[Recovery] Not resuming: the session was stopped"));
        assert_eq!(run.record.status, ExecutionStatus::Executed);
        assert_eq!(run.record.exit_code, Some(137));
    }

    #[test]
    fn finalizes_once_the_attempts_are_used_up() {
        let run = run_watcher(KILLED, json!({ "recoveryAttempts": 1 }));
        assert!(!run.calls.contains("start box"), "{}", run.calls);
        assert!(
            run.log.contains("all 1 recovery attempt(s) used"),
            "{}",
            run.log
        );
        assert_eq!(run.record.status, ExecutionStatus::Executed);
    }
}
