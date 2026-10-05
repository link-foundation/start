//! Regression tests for issue #178: `--on-kill-resume N` resumed an execution
//! whenever Docker reported `State.OOMKilled=true`, whatever the exit code.
//! Docker sets that flag when *any* process in the container's cgroup is
//! OOM-killed (a compiler, a test runner, a child `node`) and keeps it set
//! until the container is started again. A main process that survived that
//! and then exited 0 (success) or 1 (a deliberate failure) on its own was
//! resumed as if it had been killed.
//!
//! A container counts as killed only when the main process was: exit 137, or
//! `OOMKilled=true` with no usable exit code (the watcher's `-1`).

use serde_json::json;
use start_command::execution_recovery::{is_killed_exit, recover_killed_execution, RecoveryFacts};
use start_command::{DockerWatcherOptions, ExecutionRecord, ExecutionStatus};
use std::cell::RefCell;
use tempfile::TempDir;
#[path = "support/issue_176.rs"]
mod support;
use support::*;

/// `(exit_code, oom_killed, killed)` cases from the issue.
const CASES: [(&str, &str, bool); 8] = [
    ("137", "false", true),
    ("137", "true", true),
    ("0", "true", false),
    ("1", "true", false),
    ("1", "false", false),
    ("0", "false", false),
    ("-1", "true", true),
    ("-1", "false", false),
];

#[test]
fn is_killed_exit_only_trusts_oom_killed_without_an_exit_code() {
    for (exit_code, oom_killed, killed) in CASES {
        assert_eq!(
            is_killed_exit(exit_code, oom_killed),
            killed,
            "exit={} oom={}",
            exit_code,
            oom_killed
        );
    }
    assert!(is_killed_exit("", "true"));
    assert!(is_killed_exit("unknown", "true"));
    assert!(!is_killed_exit("", "false"));
}

#[test]
fn recover_killed_execution_does_not_resume_an_exit_0_or_1_with_oom_killed() {
    let temp = TempDir::new().unwrap();
    let store = test_store(&temp.path().join("app"));
    let record = docker_record(
        ExecutionStatus::Executing,
        None,
        json!({ "onKillResume": 1 }),
    );
    store.save(&record).unwrap();
    let runner = FakeRunner::new(updated_host_config());
    for exit_code in ["0", "1"] {
        let watchers = RefCell::new(0);
        let facts = RecoveryFacts {
            exit_code: exit_code.to_string(),
            oom_killed: "true".to_string(),
            started_at: "2026-10-03T12:00:00Z".to_string(),
            finished_at: "2026-10-03T16:55:20Z".to_string(),
            container_error: String::new(),
            ..Default::default()
        };
        let outcome = recover_killed_execution(
            &store,
            &record.uuid,
            &facts,
            &runner,
            &|_: &str, _: &ExecutionRecord, _: &DockerWatcherOptions| {
                *watchers.borrow_mut() += 1;
            },
        );
        assert!(!outcome.recovered, "exit={}", exit_code);
        assert_eq!(outcome.reason, "not-killed");
        assert_eq!(*watchers.borrow(), 0);
    }
    assert!(runner.calls().is_empty());
    let stored = store.get(&record.uuid).unwrap();
    assert!(!stored.options.contains_key("recoveryAttempts"));
}

#[cfg(unix)]
mod shell {
    use super::*;
    use start_command::docker_post_mortem::shell_vars;
    use start_command::execution_recovery::build_recovery_snippet;
    use start_command::{
        build_detached_docker_completion_script_with, DockerContainerCleanupPolicy,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    #[test]
    fn the_watcher_shell_condition_agrees_with_is_killed_exit() {
        // Only the condition: the command after it would start a real recovery.
        let snippet = build_recovery_snippet("uuid");
        let end = snippet.find("; }; } && ").expect("condition") + "; }; }".len();
        let condition = &snippet[..end];
        let extra = [("", "true", true), ("unknown", "true", true)];
        for (exit_code, oom_killed, killed) in CASES.iter().chain(extra.iter()) {
            let output = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!(
                    "{}='{}'; {}='{}'; if {}; then echo recover; else echo keep; fi",
                    shell_vars::EXIT,
                    exit_code,
                    shell_vars::OOM,
                    oom_killed,
                    condition
                ))
                .output()
                .expect("sh");
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim(),
                if *killed { "recover" } else { "keep" },
                "exit={} oom={}",
                exit_code,
                oom_killed
            );
            assert!(output.stderr.is_empty(), "{:?}", output);
        }
    }

    const TIMES: &str = "2026-10-03T12:00:00.000000000Z 2026-10-03T16:55:20.000000000Z";

    struct WatcherRun {
        calls: String,
        log: String,
        record: ExecutionRecord,
    }

    /// Run the real watcher against a fake docker that reports `state`.
    fn run_watcher(state: &str) -> WatcherRun {
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
        let mut record = docker_record(
            ExecutionStatus::Executing,
            Some(&log_path),
            json!({ "onKillResume": 1 }),
        );
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

    fn assert_finalized_without_resuming(exit_code: i32) {
        let run = run_watcher(&format!("{} true {}", exit_code, TIMES));
        assert!(!run.calls.contains("start box"), "{}", run.calls);
        assert!(!run.log.contains("[Recovery"), "{}", run.log);
        // Still reported as an OOM event in the post-mortem and the record.
        assert!(run.log.contains("OOMKilled:  true"), "{}", run.log);
        assert_eq!(run.record.status, ExecutionStatus::Executed);
        assert_eq!(run.record.exit_code, Some(exit_code));
        assert_eq!(run.record.oom_killed, Some(true));
        assert!(!run.record.options.contains_key("recoveryAttempts"));
    }

    #[test]
    fn the_watcher_finalizes_exit_0_with_oom_killed_without_resuming() {
        assert_finalized_without_resuming(0);
    }

    #[test]
    fn the_watcher_finalizes_exit_1_with_oom_killed_without_resuming() {
        assert_finalized_without_resuming(1);
    }
}
