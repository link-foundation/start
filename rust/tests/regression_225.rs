//! Regression tests for issue #225: after a kept docker container was removed,
//! `$ --status` kept reporting it exactly as before — same `containerId`,
//! nothing saying the container no longer exists.
//!
//! `docker inspect` exits 1 with `No such object` / `No such container` for a
//! removed container, which used to be folded into the same `None` as a docker
//! that cannot be reached at all.

use serde_json::Value;
use start_command::container_removal::{is_docker_not_found, CONTAINER_STATE_REMOVED};
use start_command::detached_finalize::finalize_detached_execution_with_removal;
use start_command::{
    DetachedFinalizeFacts, ExecutionRecord, ExecutionRecordOptions, ExecutionStatus,
    ExecutionStore, ExecutionStoreOptions,
};
use std::collections::HashMap;
use std::path::Path;
use tempfile::TempDir;

fn kept_container_record(status: ExecutionStatus) -> ExecutionRecord {
    let mut options = HashMap::new();
    for (key, value) in [
        ("isolated", "docker"),
        ("isolationMode", "detached"),
        ("sessionName", "status-removal-demo"),
        ("containerId", "d2a8c0ffee"),
    ] {
        options.insert(key.to_string(), Value::String(value.to_string()));
    }
    let executed = status == ExecutionStatus::Executed;
    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sh -c 'echo working; exit 1'".to_string(),
        uuid: Some("issue225-rust".to_string()),
        status: Some(status),
        exit_code: executed.then_some(1),
        start_time: Some("2026-10-19T00:00:00.000Z".to_string()),
        end_time: executed.then(|| "2026-10-19T00:00:10.000Z".to_string()),
        options: Some(options),
        ..Default::default()
    })
}

fn test_store(dir: &Path) -> ExecutionStore {
    ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.to_path_buf()),
        use_links: Some(false),
        verbose: false,
    })
}

#[test]
fn recognises_the_not_found_answers_of_docker_inspect() {
    for stderr in [
        "error: no such object: status-removal-demo",
        "Error: No such object: status-removal-demo",
        "Error response from daemon: No such container: status-removal-demo",
    ] {
        assert!(is_docker_not_found(false, stderr), "{stderr}");
    }
}

#[test]
fn does_not_read_an_unreachable_daemon_as_a_removed_container() {
    for stderr in [
        "failed to connect to the docker API at unix:///var/run/docker.sock: connect: no such file or directory",
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
        "",
    ] {
        assert!(!is_docker_not_found(false, stderr), "{stderr}");
    }
    assert!(!is_docker_not_found(true, "No such object"));
}

#[test]
fn the_finalizer_records_a_removal_by_the_cleanup_policy() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let record = kept_container_record(ExecutionStatus::Executing);
    store.save(&record).unwrap();
    let outcome = finalize_detached_execution_with_removal(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "0".into(),
            oom_killed: "false".into(),
            started_at: "2026-10-19T00:00:00Z".into(),
            finished_at: "2026-10-19T00:00:10Z".into(),
            running: "false".into(),
            ..Default::default()
        },
        None,
        true,
    );
    assert!(outcome.updated, "{outcome:?}");
    let stored = store.get(&record.uuid).unwrap();
    assert_eq!(
        stored.container_state.as_deref(),
        Some(CONTAINER_STATE_REMOVED)
    );
    assert!(stored.container_removed_observed_at.is_some());
    assert_eq!(stored.options["containerId"], "d2a8c0ffee");
}

#[test]
fn the_finalizer_records_a_removal_on_an_already_finalized_record() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let record = kept_container_record(ExecutionStatus::Executed);
    store.save(&record).unwrap();
    let outcome = finalize_detached_execution_with_removal(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            running: "false".into(),
            ..Default::default()
        },
        None,
        true,
    );
    assert_eq!(outcome.reason, "container-removed");
    assert_eq!(
        store.get(&record.uuid).unwrap().container_state.as_deref(),
        Some("removed")
    );
}

#[test]
fn the_finalizer_records_nothing_when_the_container_was_kept() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let record = kept_container_record(ExecutionStatus::Executing);
    store.save(&record).unwrap();
    finalize_detached_execution_with_removal(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "1".into(),
            started_at: "2026-10-19T00:00:00Z".into(),
            finished_at: "2026-10-19T00:00:10Z".into(),
            running: "false".into(),
            ..Default::default()
        },
        None,
        false,
    );
    assert_eq!(store.get(&record.uuid).unwrap().container_state, None);
}

/// The stubs below are POSIX `sh` scripts; Windows has no `/bin/sh`.
#[cfg(unix)]
mod with_fake_docker {
    use super::*;
    use start_command::{
        build_detached_docker_completion_script, query_status, DockerContainerCleanupPolicy,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    use std::process::Command;
    use std::sync::{Mutex, OnceLock};

    const NOT_FOUND: &str = "printf 'error: no such object: %s\\n' \"$4\" >&2; exit 1";
    const UNREACHABLE: &str = concat!(
        "printf 'failed to connect to the docker API at unix:///var/run/docker.sock; ",
        "check if the path is correct and if the daemon is running: dial unix ",
        "/var/run/docker.sock: connect: no such file or directory\\n' >&2; exit 1"
    );
    const EXITED: &str = "echo 'false 1 false 2026-10-19T00:00:00Z 2026-10-19T00:00:10Z'";

    fn write_script(path: &Path, body: &str) {
        std::fs::write(path, body).unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    /// Fake `docker` whose every `inspect` runs `inspect_body`; returns the
    /// recorded calls.
    fn with_docker<F: FnOnce()>(inspect_body: &str, run: F) -> Vec<String> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = TempDir::new().unwrap();
        let docker = dir.path().join("docker");
        let calls = dir.path().join("calls");
        write_script(
            &docker,
            &format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\n[ \"$1\" = inspect ] || exit 1\n{}\n",
                calls.display(),
                inspect_body
            ),
        );
        let original = std::env::var_os("START_DOCKER_BIN");
        std::env::set_var("START_DOCKER_BIN", &docker);
        let result = catch_unwind(AssertUnwindSafe(run));
        match original {
            Some(value) => std::env::set_var("START_DOCKER_BIN", value),
            None => std::env::remove_var("START_DOCKER_BIN"),
        }
        if let Err(payload) = result {
            resume_unwind(payload);
        }
        std::fs::read_to_string(calls)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn status(store: &ExecutionStore, id: &str, format: &str) -> String {
        let result = query_status(Some(store), id, Some(format));
        assert!(result.success, "{:?}", result.error);
        result.output.unwrap()
    }

    fn status_json(store: &ExecutionStore, id: &str) -> Value {
        serde_json::from_str(&status(store, id, "json")).unwrap()
    }

    fn store_with(temp: &TempDir, record: &ExecutionRecord) -> ExecutionStore {
        let store = test_store(temp.path());
        store.save(record).unwrap();
        store
    }

    #[test]
    fn status_adds_container_state_removed_and_keeps_the_container_id() {
        let temp = TempDir::new().unwrap();
        let store = store_with(&temp, &kept_container_record(ExecutionStatus::Executed));
        let calls = with_docker(NOT_FOUND, || {
            let status = status_json(&store, "status-removal-demo");
            assert_eq!(status["containerState"], "removed");
            let observed = status["containerRemovedObservedAt"].as_str().unwrap();
            assert!(chrono::DateTime::parse_from_rfc3339(observed).is_ok());
            assert_eq!(status["options"]["containerId"], "d2a8c0ffee");
            assert_eq!(status["status"], "executed");
            assert_eq!(status["exitCode"], 1);
        });
        // Probed by id, so a later container reusing the name is not mistaken
        // for this one.
        assert!(calls
            .iter()
            .any(|call| call == "inspect -f {{.Id}} d2a8c0ffee"));
    }

    #[test]
    fn status_persists_the_observation_and_keeps_its_first_time() {
        let temp = TempDir::new().unwrap();
        let store = store_with(&temp, &kept_container_record(ExecutionStatus::Executed));
        with_docker(NOT_FOUND, || {
            let first = status_json(&store, "issue225-rust")["containerRemovedObservedAt"].clone();
            let stored = store.get("issue225-rust").unwrap();
            assert_eq!(stored.container_state.as_deref(), Some("removed"));
            assert_eq!(
                stored.container_removed_observed_at.as_deref(),
                first.as_str()
            );
            assert_eq!(
                status_json(&store, "issue225-rust")["containerRemovedObservedAt"],
                first
            );
        });
    }

    #[test]
    fn status_shows_the_removal_in_links_notation_and_text() {
        let temp = TempDir::new().unwrap();
        let store = store_with(&temp, &kept_container_record(ExecutionStatus::Executed));
        with_docker(NOT_FOUND, || {
            let links = status(&store, "status-removal-demo", "links-notation");
            assert!(links.contains("\n  containerState removed"), "{links}");
            assert!(links.contains("\n  containerRemovedObservedAt "), "{links}");
            assert!(links.contains("\n    containerId d2a8c0ffee"), "{links}");
            let text = status(&store, "status-removal-demo", "text");
            assert!(text.contains("Container State:   removed"), "{text}");
            assert!(text.contains("\nContainer Removed: 20"), "{text}");
        });
    }

    #[test]
    fn status_falls_back_to_the_session_name_without_a_container_id() {
        let temp = TempDir::new().unwrap();
        let mut record = kept_container_record(ExecutionStatus::Executed);
        record.options.remove("containerId");
        let store = store_with(&temp, &record);
        with_docker(NOT_FOUND, || {
            assert_eq!(
                status_json(&store, "issue225-rust")["containerState"],
                "removed"
            );
        });
    }

    #[test]
    fn status_says_nothing_when_docker_cannot_be_reached() {
        let temp = TempDir::new().unwrap();
        let store = store_with(&temp, &kept_container_record(ExecutionStatus::Executed));
        with_docker(UNREACHABLE, || {
            let status = status_json(&store, "status-removal-demo");
            assert!(status.get("containerState").is_none(), "{status}");
            assert!(status.get("containerRemovedObservedAt").is_none());
        });
        assert_eq!(store.get("issue225-rust").unwrap().container_state, None);
    }

    #[test]
    fn status_says_nothing_while_the_container_still_exists() {
        let temp = TempDir::new().unwrap();
        let store = store_with(&temp, &kept_container_record(ExecutionStatus::Executed));
        with_docker(EXITED, || {
            assert!(status_json(&store, "status-removal-demo")
                .get("containerState")
                .is_none());
        });
    }

    #[test]
    fn status_leaves_an_executing_record_untouched_issue_136() {
        let temp = TempDir::new().unwrap();
        let store = store_with(&temp, &kept_container_record(ExecutionStatus::Executing));
        with_docker(NOT_FOUND, || {
            let status = status_json(&store, "issue225-rust");
            assert_eq!(status["status"], "executing");
            assert!(status.get("containerState").is_none());
        });
        assert_eq!(
            store.get("issue225-rust").unwrap().status,
            ExecutionStatus::Executing
        );
    }

    /// Run the real watcher against a fake docker whose `rm` exits `rm_status`.
    fn run_watcher(
        policy: DockerContainerCleanupPolicy,
        exit_code: i32,
        rm_status: i32,
    ) -> ExecutionRecord {
        let temp = TempDir::new().unwrap();
        let dir = temp.path();
        let bin_dir = dir.join("bin");
        let app_folder = dir.join("app");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let log_path = dir.join("run.log");
        write_script(
            &bin_dir.join("docker"),
            &[
                "#!/bin/sh".to_string(),
                "[ \"$START_COMMAND_CGROUP_SAMPLING\" = 1 ] && exit 1".to_string(),
                "case \"$1\" in".to_string(),
                "  inspect)".to_string(),
                "    case \"$3\" in".to_string(),
                "      *HostConfig*) exit 1 ;;".to_string(),
                "      *State.Running*) echo false ;;".to_string(),
                "      *State.Error*) echo \"\" ;;".to_string(),
                "      *'{{.Id}}'*|*State.Pid*) echo 0 ;;".to_string(),
                format!(
                    "      *) echo '{} false 2026-10-19T00:00:00Z 2026-10-19T00:00:10Z' ;;",
                    exit_code
                ),
                "    esac ;;".to_string(),
                "  logs) echo work ;;".to_string(),
                "  wait) echo 0 ;;".to_string(),
                format!("  rm) exit {} ;;", rm_status),
                "  *) exit 1 ;;".to_string(),
                "esac".to_string(),
                String::new(),
            ]
            .join("\n"),
        );
        let store = test_store(&app_folder);
        let mut record = kept_container_record(ExecutionStatus::Executing);
        record.log_path = log_path.to_string_lossy().to_string();
        store.save(&record).unwrap();
        let script = build_detached_docker_completion_script(
            "status-removal-demo",
            policy,
            Some(&log_path),
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
            .env_remove("START_DOCKER_BIN")
            .output()
            .expect("sh");
        assert!(output.status.success(), "watcher failed: {:?}", output);
        test_store(&app_folder).get(&record.uuid).unwrap()
    }

    #[test]
    fn the_watcher_marks_the_record_when_its_docker_rm_succeeded() {
        let record = run_watcher(DockerContainerCleanupPolicy::Always, 0, 0);
        assert_eq!(record.status, ExecutionStatus::Executed);
        assert_eq!(record.container_state.as_deref(), Some("removed"));
        assert!(record.container_removed_observed_at.is_some());
    }

    #[test]
    fn the_watcher_does_not_mark_a_kept_container() {
        let record = run_watcher(DockerContainerCleanupPolicy::Default, 1, 0);
        assert_eq!(record.status, ExecutionStatus::Executed);
        assert_eq!(record.exit_code, Some(1));
        assert_eq!(record.container_state, None);
    }

    #[test]
    fn the_watcher_does_not_mark_a_container_whose_docker_rm_failed() {
        let record = run_watcher(DockerContainerCleanupPolicy::Always, 0, 1);
        assert_eq!(record.status, ExecutionStatus::Executed);
        assert_eq!(record.container_state, None);
    }
}
