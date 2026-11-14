//! Regression tests for issue #263 that spawn Docker: `--status`, `--list`
//! and `cleanup_stale` against a fake `docker` binary, the watcher snippet, and
//! the real CLI against real Docker (same process across pause/unpause).
//! Unix only: the fake binary is a shell script.

#![cfg(unix)]

#[path = "support/issue_263.rs"]
mod support;
use serde_json::{json, Value};
use start_command::{ExecutionStatus, ExecutionStore};
use std::time::Duration;
use support::*;
use tempfile::TempDir;

/// Status, list and `cleanup_stale` spawn docker themselves: run them against
/// a fake `docker` binary holding one container (or none: "removed").
mod fake_docker_binary {
    use super::*;
    use start_command::status_formatter::{list_executions_filtered, query_status};
    use start_command::CleanupOptions;
    use std::os::unix::fs::PermissionsExt;
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    use std::sync::{Mutex, OnceLock};

    /// Renders every `{{.Field}}` of the format from `$FAKE_DIR/container`
    /// (`.Field value` lines); a missing container answers like Docker 29.
    const SCRIPT: &str = r#"#!/bin/sh
[ "$1" = inspect ] || exit 1
shift
[ "$1" = --type ] && shift 2
fmt=$2
shift 2
status=0
for target in "$@"; do
  if [ ! -s "$FAKE_DIR/container" ] || ! grep -q "^.Name /$target\$" "$FAKE_DIR/container"; then
    echo "Error response from daemon: No such container: $target" >&2
    status=1
    continue
  fi
  awk -v f="$fmt" '{ key = "{{" $1 "}}"; while ((i = index(f, key)) > 0) f = substr(f, 1, i - 1) $2 substr(f, i + length(key)) } END { gsub(/\{\{[^}]*\}\}/, "", f); print f }' "$FAKE_DIR/container"
done
exit $status
"#;

    fn container(status: &str) -> String {
        let exited = status == "exited";
        let running = status == "running" || status == "paused";
        [
            (".Name", format!("/{NAME}")),
            (".Id", "abc263def".to_string()),
            (".State.Pid", if exited { "0" } else { "4242" }.to_string()),
            (".State.Running", running.to_string()),
            (
                ".State.ExitCode",
                if exited { "137" } else { "0" }.to_string(),
            ),
            (".State.OOMKilled", "false".to_string()),
            (".State.StartedAt", "2026-11-13T08:00:00Z".to_string()),
            (
                ".State.FinishedAt",
                if exited {
                    "2026-11-13T08:05:00Z"
                } else {
                    "0001-01-01T00:00:00Z"
                }
                .to_string(),
            ),
            (".State.Status", status.to_string()),
            (".State.Paused", (status == "paused").to_string()),
        ]
        .iter()
        .map(|(key, value)| format!("{key} {value}\n"))
        .collect()
    }

    fn with_docker<T>(status: &str, run: impl FnOnce() -> T) -> T {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = TempDir::new().unwrap();
        let docker = dir.path().join("docker");
        std::fs::write(&docker, SCRIPT).unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let contents = if status == "removed" {
            String::new()
        } else {
            container(status)
        };
        std::fs::write(dir.path().join("container"), contents).unwrap();
        let original = std::env::var_os("START_DOCKER_BIN");
        std::env::set_var("START_DOCKER_BIN", &docker);
        std::env::set_var("FAKE_DIR", dir.path());
        let result = catch_unwind(AssertUnwindSafe(run));
        match original {
            Some(value) => std::env::set_var("START_DOCKER_BIN", value),
            None => std::env::remove_var("START_DOCKER_BIN"),
        }
        std::env::remove_var("FAKE_DIR");
        result.unwrap_or_else(|payload| resume_unwind(payload))
    }

    fn status_json(store: &ExecutionStore, status: &str) -> Value {
        with_docker(status, || {
            let result = query_status(Some(store), NAME, Some("json"));
            assert!(result.success, "{:?}", result.error);
            json_output(result.output)
        })
    }

    #[test]
    fn status_reports_a_paused_execution_as_executing_with_pause_fields() {
        let (_dir, store) = make_store();
        store.save(&make_record(&paused_extra())).unwrap();
        let status = status_json(&store, "paused");
        assert_eq!(status["status"], json!("executing"));
        assert_eq!(status["dockerState"], json!("paused"));
        assert_eq!(status["paused"], json!(true));
        assert_eq!(status["pausedAt"], json!("2026-11-13T08:01:00Z"));
        assert!(status["exitCode"].is_null());
    }

    #[test]
    fn status_text_shows_the_docker_state_and_pause() {
        let (_dir, store) = make_store();
        store.save(&make_record(&paused_extra())).unwrap();
        let text = with_docker("paused", || {
            query_status(Some(&store), NAME, Some("text"))
                .output
                .unwrap()
        });
        assert!(text.contains("Docker State:      paused"), "{text}");
        assert!(text.contains("Paused:            true"), "{text}");
        assert!(
            text.contains("Paused At:         2026-11-13T08:01:00Z"),
            "{text}"
        );
    }

    #[test]
    fn list_and_list_running_include_paused_executions() {
        let (_dir, store) = make_store();
        store.save(&make_record(&paused_extra())).unwrap();
        for running in [false, true] {
            let list = with_docker("paused", || {
                json_output(list_executions_filtered(Some(&store), Some("json"), running).output)
            });
            let rows = list
                .get("executions")
                .cloned()
                .unwrap_or_else(|| list.clone());
            let rows = rows.as_array().expect("rows");
            assert_eq!(rows.len(), 1, "running={running}: {list}");
            assert_eq!(rows[0]["uuid"], json!(UUID));
            assert_eq!(rows[0]["status"], json!("executing"));
            assert_eq!(rows[0]["dockerState"], json!("paused"));
            assert_eq!(rows[0]["paused"], json!(true));
        }
    }

    #[test]
    fn a_stale_pause_is_reconciled_when_docker_says_it_exited() {
        let (_dir, store) = make_store();
        store.save(&make_record(&paused_extra())).unwrap();
        let status = status_json(&store, "exited");
        assert_eq!(status["dockerState"], json!("exited"));
        assert_eq!(status["paused"], json!(false));
        assert_ne!(status["status"], json!("executing"));
        let options = saved_options(&store);
        assert_eq!(options["paused"], json!(false));
        assert_eq!(options["pauseEndedBy"], json!("reconcile"));
    }

    #[test]
    fn a_stale_pause_is_reconciled_when_docker_says_it_is_running() {
        let (_dir, store) = make_store();
        store.save(&make_record(&paused_extra())).unwrap();
        let status = status_json(&store, "running");
        assert_eq!(status["status"], json!("executing"));
        assert_eq!(status["dockerState"], json!("running"));
        assert_eq!(status["paused"], json!(false));
        assert_eq!(saved_options(&store)["paused"], json!(false));
    }

    #[test]
    fn a_removed_container_after_a_reboot_shows_as_removed_not_paused() {
        let (_dir, store) = make_store();
        store.save(&make_record(&paused_extra())).unwrap();
        let status = status_json(&store, "removed");
        assert_eq!(status["dockerState"], json!("removed"));
        assert_eq!(status["paused"], json!(false));
        assert_eq!(saved_options(&store)["paused"], json!(false));
    }

    #[test]
    fn a_pause_made_outside_start_command_is_adopted_by_status() {
        let (_dir, store) = make_store();
        store.save(&make_record(&[])).unwrap();
        let status = status_json(&store, "paused");
        assert_eq!(status["paused"], json!(true));
        assert_eq!(saved_options(&store)["paused"], json!(true));
    }

    #[test]
    fn cleanup_stale_never_cleans_a_docker_confirmed_paused_execution() {
        let (_dir, store) = make_store();
        store.save(&make_record(&paused_extra())).unwrap();
        let kept = with_docker("paused", || store.cleanup_stale(CleanupOptions::default()));
        assert_eq!(kept.cleaned, 0);
        assert_eq!(store.get(UUID).unwrap().status, ExecutionStatus::Executing);
        // A stale recorded pause does not hide the dead record forever.
        let cleaned = with_docker("removed", || store.cleanup_stale(CleanupOptions::default()));
        assert_eq!(cleaned.cleaned, 1);
    }

    #[test]
    fn the_watcher_keeps_waiting_while_paused_and_stops_once_it_exits() {
        use start_command::build_docker_wait_for_exit_snippet;
        use std::process::{Command, Stdio};
        use std::time::Instant;

        let dir = TempDir::new().unwrap();
        let state = dir.path().join("state");
        // Docker keeps `.State.Running=true` for a paused container.
        std::fs::write(&state, "true").unwrap();
        let docker = dir.path().join("docker");
        std::fs::write(
            &docker,
            format!(
                "#!/bin/sh\nif [ \"$1\" = inspect ]; then cat '{}'; echo; exit 0; fi\nsleep 0.1; exit 1\n",
                state.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!(
            "{}:{}",
            dir.path().display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let snippet = build_docker_wait_for_exit_snippet(NAME, None);
        let spawn = || {
            Command::new("sh")
                .arg("-c")
                .arg(&snippet)
                .env("PATH", &path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        };
        let mut paused = spawn();
        std::thread::sleep(Duration::from_millis(1500));
        // Still in its wait loop: a paused container is not completed.
        assert!(paused.try_wait().unwrap().is_none());
        paused.kill().unwrap();
        paused.wait().unwrap();

        std::fs::write(&state, "false").unwrap();
        let mut exited = spawn();
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = exited.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "watcher never stopped");
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(status.success());
    }
}

/// End to end with the real CLI and Docker, when Linux images can run.
mod real_docker {
    use super::*;
    use std::process::{Command, Output};

    fn docker_ready() -> bool {
        Command::new("docker")
            .args(["run", "--rm", "alpine:3.23", "true"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn docker(args: &[&str]) -> String {
        Command::new("docker")
            .args(args)
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn pause_and_unpause_keep_the_same_process_and_the_cli_reports_it() {
        if !docker_ready() {
            eprintln!("skipping: docker cannot run Linux images here");
            return;
        }
        let root = TempDir::new().unwrap();
        let name = format!("t263-rs-{}", std::process::id());
        let cli = |args: &[&str]| -> Output {
            Command::new(env!("CARGO_BIN_EXE_start"))
                .args(args)
                .env("HOME", root.path())
                .env("START_APP_FOLDER", root.path().join("app"))
                .env("START_LOG_DIR", root.path().join("logs"))
                .env("START_DISABLE_AUTO_ISSUE", "1")
                .env("START_DISABLE_LOG_UPLOAD", "1")
                .env_remove("START_EXECUTION_ID")
                .env_remove("START_DOCKER_BIN")
                .output()
                .unwrap()
        };
        let stdout = |output: &Output| String::from_utf8_lossy(&output.stdout).to_string();
        let all = |output: &Output| {
            format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        };
        let check = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let launched = cli(&[
                "--isolated",
                "docker",
                "--detached",
                "--image",
                "alpine:3.23",
                "--session",
                &name,
                "--",
                "sleep 300",
            ]);
            assert!(launched.status.success(), "{}", all(&launched));
            let pid_before = docker(&["inspect", "-f", "{{.State.Pid}}", &name]);
            assert!(pid_before.parse::<u32>().unwrap_or(0) > 0, "{pid_before}");

            let paused = cli(&["--pause", &name, "--output-format", "json"]);
            assert!(paused.status.success(), "{}", all(&paused));
            let report: Value = serde_json::from_str(&stdout(&paused)).unwrap();
            assert_eq!(report["status"], json!("paused"));
            assert_eq!(
                docker(&["inspect", "-f", "{{.State.Status}}", &name]),
                "paused"
            );
            assert!(stdout(&cli(&["--pause", &name])).contains("already-paused"));

            let status: Value = serde_json::from_str(&stdout(&cli(&[
                "--status",
                &name,
                "--output-format",
                "json",
            ])))
            .unwrap();
            assert_eq!(status["status"], json!("executing"));
            assert_eq!(status["dockerState"], json!("paused"));
            assert_eq!(status["paused"], json!(true));
            let running = cli(&["--list", "--running", "--output-format", "json"]);
            assert!(stdout(&running).contains(&name));

            for refused in [vec!["--attach", &name], vec!["--resume", &name]] {
                let output = cli(&refused);
                assert!(!output.status.success(), "{refused:?}");
                assert!(all(&output).contains("--unpause"), "{}", all(&output));
            }
            assert!(!cli(&["--cleanup", &name]).status.success());
            assert_eq!(
                docker(&["inspect", "-f", "{{.State.Status}}", &name]),
                "paused"
            );

            let unpaused = cli(&["--unpause", &name, "--output-format", "json"]);
            assert!(unpaused.status.success(), "{}", all(&unpaused));
            let report: Value = serde_json::from_str(&stdout(&unpaused)).unwrap();
            assert_eq!(report["status"], json!("unpaused"));
            assert_eq!(
                docker(&["inspect", "-f", "{{.State.Pid}}", &name]),
                pid_before
            );
            assert!(stdout(&cli(&["--unpause", &name])).contains("not-paused"));

            assert!(cli(&["--pause", &name]).status.success());
            assert!(cli(&["--terminate", &name]).status.success());
            let ended: Value = serde_json::from_str(&stdout(&cli(&[
                "--status",
                &name,
                "--output-format",
                "json",
            ])))
            .unwrap();
            assert_eq!(ended["paused"], json!(false));
            assert!(ended["options"]["stopRequestedAt"].is_string(), "{ended}");
            let again = cli(&["--unpause", &name]);
            assert!(!again.status.success());
            assert!(all(&again).contains("--resume"), "{}", all(&again));
        }));
        let _ = Command::new("docker").args(["rm", "-f", &name]).output();
        if let Err(payload) = check {
            std::panic::resume_unwind(payload);
        }
    }
}
