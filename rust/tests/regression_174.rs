//! Regression tests for issue #174: the detached docker watcher `docker rm -f`ed
//! a still-running container when `docker logs -f` failed (ENOSPC) and
//! finalized it as executed / exit 0.
//!
//!   - `docker logs -f C >> LOG` also returns when its own write to LOG fails,
//!     and on a dockerd restart; the watcher must wait for the real exit;
//!   - a container that is still running must never be removed, get an
//!     `Exit Code:` footer, or be finalized;
//!   - `ExitCode=0` next to a zero `FinishedAt` is Docker's zero value, never an
//!     observed exit 0.

use serde_json::Value;
use start_command::{
    finalize_detached_execution, DetachedFinalizeFacts, ExecutionRecord, ExecutionRecordOptions,
    ExecutionStatus, ExecutionStore, ExecutionStoreOptions, WATCHER_LOST_CONTAINER,
};
use std::collections::HashMap;
use std::path::Path;
use tempfile::TempDir;

fn test_store(dir: &Path) -> ExecutionStore {
    ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.to_path_buf()),
        use_links: Some(false),
        verbose: false,
    })
}

fn detached_docker_record(log_path: Option<&Path>) -> ExecutionRecord {
    let mut options = HashMap::new();
    options.insert(
        "sessionName".to_string(),
        Value::String("start-command-174".to_string()),
    );
    options.insert("isolated".to_string(), Value::String("docker".to_string()));
    options.insert(
        "isolationMode".to_string(),
        Value::String("detached".to_string()),
    );
    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "work".to_string(),
        status: Some(ExecutionStatus::Executing),
        log_path: log_path.map(|path| path.to_string_lossy().to_string()),
        options: Some(options),
        ..Default::default()
    })
}

fn facts(exit_code: &str, finished_at: &str, running: &str) -> DetachedFinalizeFacts {
    DetachedFinalizeFacts {
        exit_code: exit_code.to_string(),
        oom_killed: "false".to_string(),
        started_at: "2026-09-27T10:00:00Z".to_string(),
        finished_at: finished_at.to_string(),
        container_error: String::new(),
        running: running.to_string(),
        ..Default::default()
    }
}

#[test]
fn finalize_refuses_a_record_whose_container_is_still_running() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let record = detached_docker_record(None);
    store.save(&record).unwrap();

    let outcome = finalize_detached_execution(
        &store,
        &record.uuid,
        &facts("0", "0001-01-01T00:00:00Z", "true"),
    );

    assert!(!outcome.updated);
    assert_eq!(outcome.reason, "still-running");
    let stored = store.get(&record.uuid).unwrap();
    assert_eq!(stored.status, ExecutionStatus::Executing);
    assert_eq!(stored.exit_code, None);
}

#[test]
fn finalize_does_not_trust_exit_0_without_a_finished_at() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let record = detached_docker_record(None);
    store.save(&record).unwrap();

    finalize_detached_execution(
        &store,
        &record.uuid,
        &facts("0", "0001-01-01T00:00:00Z", "false"),
    );

    let stored = store.get(&record.uuid).unwrap();
    assert_eq!(stored.exit_code, Some(-1));
    assert_eq!(stored.exit_reason.as_deref(), Some(WATCHER_LOST_CONTAINER));
    assert_eq!(stored.end_time_source.as_deref(), Some("observed-at"));
}

#[test]
fn finalize_still_records_a_real_exit_0() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let record = detached_docker_record(None);
    store.save(&record).unwrap();

    finalize_detached_execution(
        &store,
        &record.uuid,
        &facts("0", "2026-09-27T10:00:05Z", "false"),
    );

    let stored = store.get(&record.uuid).unwrap();
    assert_eq!(stored.exit_code, Some(0));
    assert_eq!(stored.exit_reason, None);
    assert_eq!(
        stored.end_time_source.as_deref(),
        Some("docker-finished-at")
    );
}

// ---------------------------------------------------------------------------
// The generated watcher shell, run against a scripted fake `docker`
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod shell {
    use super::*;
    use start_command::{
        build_detached_docker_completion_script, DockerContainerCleanupPolicy,
        LOG_CAPTURE_STOPPED_NOTE, STILL_RUNNING_NOTE,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    const FINISHED_7: &str =
        "7 false 2026-09-27T10:00:00.000000000Z 2026-09-27T10:00:05.000000000Z";
    const FINISHED_0: &str =
        "0 false 2026-09-27T10:00:00.000000000Z 2026-09-27T10:00:05.000000000Z";
    const NOT_FINISHED: &str = "0 false 2026-09-27T10:00:00Z 0001-01-01T00:00:00Z";

    struct WatcherRun {
        calls: Vec<String>,
        log: String,
        record: ExecutionRecord,
    }

    impl WatcherRun {
        fn count(&self, call: &str) -> usize {
            self.calls.iter().filter(|value| *value == call).count()
        }

        fn position(&self, call: &str) -> Option<usize> {
            self.calls.iter().position(|value| value == call)
        }

        fn removed(&self) -> bool {
            self.calls.iter().any(|value| value.starts_with("rm"))
        }
    }

    /// Run the real watcher script against a scripted fake `docker`.
    ///
    /// `running` lists the successive answers to `docker inspect -f
    /// '{{.State.Running}}'` (`true`, `false`, or `fail` for an inspect that
    /// errors, as during a dockerd restart); the last answer sticks. `docker
    /// logs` writes one line and fails, exactly like `docker logs -f C >> LOG`
    /// whose write hit ENOSPC. Every call is recorded, and `rm` records whether
    /// the container was running at that moment.
    fn run_watcher(
        policy: DockerContainerCleanupPolicy,
        running: &[&str],
        state: &str,
        with_log: bool,
    ) -> WatcherRun {
        let temp = TempDir::new().unwrap();
        let dir = temp.path();
        let bin_dir = dir.join("bin");
        let app_folder = dir.join("app");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let log_path = dir.join("run.log");
        std::fs::write(dir.join("running"), format!("{}\n", running.join("\n"))).unwrap();
        std::fs::write(dir.join("state"), format!("{}\n", state)).unwrap();
        let docker_path = bin_dir.join("docker");
        std::fs::write(
            &docker_path,
            [
                "#!/bin/sh".to_string(),
                format!("dir='{}'", dir.display()),
                "case \"$1\" in".to_string(),
                "  inspect)".to_string(),
                "    case \"$3\" in".to_string(),
                "      *State.Running*)".to_string(),
                "        answer=$(head -n 1 \"$dir/running\")".to_string(),
                "        if [ \"$(wc -l < \"$dir/running\")\" -gt 1 ]; then".to_string(),
                "          tail -n +2 \"$dir/running\" > \"$dir/running.next\" && mv \"$dir/running.next\" \"$dir/running\"".to_string(),
                "        fi".to_string(),
                "        echo \"inspect-running $answer\" >> \"$dir/calls\"".to_string(),
                "        [ \"$answer\" = fail ] && exit 1".to_string(),
                "        echo \"$answer\" > \"$dir/current\"".to_string(),
                "        echo \"$answer\" ;;".to_string(),
                "      *State.Error*) echo \"\" ;;".to_string(),
                // The cgroup sampler (issue #182): no cgroup to find here.
                "      *'{{.Id}}'*|*State.Pid*) echo 0 ;;".to_string(),
                "      *) echo \"inspect-state\" >> \"$dir/calls\"; cat \"$dir/state\" ;;".to_string(),
                "    esac ;;".to_string(),
                "  logs) echo logs >> \"$dir/calls\"; echo work; exit 1 ;;".to_string(),
                "  wait) echo wait >> \"$dir/calls\"; echo 0 ;;".to_string(),
                "  rm) echo \"rm running=$(cat \"$dir/current\" 2>/dev/null)\" >> \"$dir/calls\" ;;".to_string(),
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
        let record = detached_docker_record(with_log.then_some(log_path.as_path()));
        store.save(&record).unwrap();

        let script = build_detached_docker_completion_script(
            "demo",
            policy,
            with_log.then_some(&log_path),
            Some(&record.uuid),
        );
        // The finalizer re-invokes the running executable, which here is the
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

        let calls = std::fs::read_to_string(dir.join("calls")).unwrap_or_default();
        WatcherRun {
            calls: calls.lines().map(str::to_string).collect(),
            log: std::fs::read_to_string(&log_path).unwrap_or_default(),
            record: test_store(&app_folder).get(&record.uuid).unwrap(),
        }
    }

    #[test]
    fn waits_for_the_real_exit_after_docker_logs_fails() {
        let run = run_watcher(
            DockerContainerCleanupPolicy::Default,
            &["true", "true", "false"],
            FINISHED_7,
            true,
        );

        let wait_at = run.position("wait").expect("docker wait was never called");
        assert!(wait_at > run.position("logs").unwrap());
        let last_wait = run.calls.iter().rposition(|call| call == "wait").unwrap();
        assert!(run.position("inspect-state").unwrap() > last_wait);
        assert!(run.log.contains(LOG_CAPTURE_STOPPED_NOTE), "{}", run.log);
        assert!(run.log.contains("Exit Code: 7"), "{}", run.log);
        assert!(!run.log.contains("Exit Code: 0"), "{}", run.log);
        assert_eq!(run.record.status, ExecutionStatus::Executed);
        assert_eq!(run.record.exit_code, Some(7));
        assert_eq!(
            run.record.end_time_source.as_deref(),
            Some("docker-finished-at")
        );
    }

    #[test]
    fn only_removes_the_container_once_it_has_really_exited() {
        let run = run_watcher(
            DockerContainerCleanupPolicy::Always,
            &["true", "true", "false"],
            FINISHED_0,
            true,
        );

        assert_eq!(run.count("rm running=false"), 1, "{:?}", run.calls);
        assert_eq!(run.count("rm running=true"), 0, "{:?}", run.calls);
        assert!(run.log.contains("Exit Code: 0"), "{}", run.log);
        assert_eq!(run.record.exit_code, Some(0));
    }

    #[test]
    fn keeps_waiting_across_a_failed_docker_inspect() {
        let run = run_watcher(
            DockerContainerCleanupPolicy::Default,
            &["true", "true", "true", "false"],
            FINISHED_7,
            true,
        );

        assert_eq!(run.count("wait"), 2, "{:?}", run.calls);
        assert_eq!(run.record.exit_code, Some(7));
    }

    #[test]
    fn applies_the_same_wait_to_the_no_log_watcher() {
        let run = run_watcher(
            DockerContainerCleanupPolicy::Always,
            &["true", "false"],
            FINISHED_7,
            false,
        );

        assert_eq!(run.count("wait"), 2, "{:?}", run.calls);
        assert_eq!(run.count("rm running=false"), 1, "{:?}", run.calls);
        assert_eq!(run.count("rm running=true"), 0, "{:?}", run.calls);
        assert_eq!(run.record.exit_code, Some(7));
    }

    #[test]
    fn never_removes_footers_or_finalizes_a_running_container() {
        // logs -f fails -> running; the wait loop's inspect fails (daemon down)
        // -> the loop ends; once the daemon is back the container still runs.
        let run = run_watcher(
            DockerContainerCleanupPolicy::Always,
            &["true", "fail", "true"],
            NOT_FINISHED,
            true,
        );

        assert!(!run.removed(), "{:?}", run.calls);
        assert!(
            run.log.contains("Container still running: demo"),
            "{}",
            run.log
        );
        assert!(run.log.contains(STILL_RUNNING_NOTE), "{}", run.log);
        assert!(!run.log.contains("Exit Code:"), "{}", run.log);
        assert_eq!(run.record.status, ExecutionStatus::Executing);
        assert_eq!(run.record.exit_code, None);
    }

    #[test]
    fn never_removes_a_running_container_without_a_log_either() {
        let run = run_watcher(
            DockerContainerCleanupPolicy::Always,
            &["fail", "true"],
            NOT_FINISHED,
            false,
        );

        assert!(!run.removed(), "{:?}", run.calls);
        assert_eq!(run.record.status, ExecutionStatus::Executing);
    }

    #[test]
    fn a_zero_finished_at_keeps_the_container_and_records_no_success() {
        let run = run_watcher(
            DockerContainerCleanupPolicy::Default,
            &["false"],
            NOT_FINISHED,
            true,
        );

        assert!(!run.removed(), "{:?}", run.calls);
        assert!(run.log.contains("Exit Code: -1"), "{}", run.log);
        assert!(!run.log.contains("Exit Code: 0"), "{}", run.log);
        assert_eq!(run.record.status, ExecutionStatus::Executed);
        assert_eq!(run.record.exit_code, Some(-1));
        assert_eq!(
            run.record.exit_reason.as_deref(),
            Some(WATCHER_LOST_CONTAINER)
        );
        assert_eq!(run.record.end_time_source.as_deref(), Some("observed-at"));
    }
}
