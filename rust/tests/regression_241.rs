//! Issue #241: a daemon restart was attributed only from
//! `journalctl -u docker.service`. With a mounted docker.sock
//! (Docker-outside-of-Docker) there is no host journal, so a task that the
//! restart force-killed ended with `Exit evidence: unavailable`.
//!
//! `docker events` cannot help (its buffer does not survive the restart), but
//! `State.FinishedAt` / `State.StartedAt` of the other containers do.
use serde_json::json;
use start_command::exit_evidence::{
    collect, daemon_restart_api_evidence, evidence_json, from_log, DAEMON_RESTART,
    DAEMON_RESTART_API, MAIN_OOM,
};
use start_command::exit_reason::resolve_exit_reason;
use start_command::{CommandRunOutput, CommandRunner};
use std::cell::RefCell;
use std::sync::Mutex;

static ENV: Mutex<()> = Mutex::new(());
const FINISHED: &str = "2026-10-21T10:05:00.123456789Z";
const UNAVAILABLE: &str =
    "Exit evidence: unavailable (no attributed exit-time OOM or daemon restart evidence)";

fn task() -> String {
    "a".repeat(64)
}
fn peer() -> String {
    "b".repeat(64)
}
fn state(id: &str, finished: &str, started: &str, exit: i32, oom: &str) -> String {
    format!("{} {} {} {} {}", id, finished, started, exit, oom)
}
/// Two containers that finished in the same second, the shape of a restart.
fn together() -> String {
    [
        state(&task(), FINISHED, "2026-10-21T10:00:00Z", 137, "false"),
        state(
            &peer(),
            "2026-10-21T10:05:00.9Z",
            "2026-10-21T09:00:00Z",
            137,
            "false",
        ),
    ]
    .join("\n")
}

/// Runner answering like a daemon reached through a mounted socket.
struct SocketOnly {
    states: String,
    calls: RefCell<Vec<Vec<String>>>,
}
impl CommandRunner for SocketOnly {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        let mut call = vec![command.to_string()];
        call.extend(args.iter().cloned());
        self.calls.borrow_mut().push(call);
        let ok = |stdout: String| CommandRunOutput {
            success: true,
            stdout,
            ..Default::default()
        };
        // No host journal inside the container.
        if command == "journalctl" {
            return CommandRunOutput::default();
        }
        match args.first().map(String::as_str) {
            Some("inspect") if args.get(2).map(String::as_str) == Some("{{.Id}}") => {
                ok(format!("{}\n", task()))
            }
            Some("events") => ok(String::new()),
            Some("ps") => ok(format!("{}\n{}\n", task(), peer())),
            Some("inspect") => ok(self.states.clone()),
            _ => CommandRunOutput::default(),
        }
    }
}
fn runner(states: &str) -> SocketOnly {
    SocketOnly {
        states: states.into(),
        calls: RefCell::new(Vec::new()),
    }
}

/// Runs `body` with `DOCKER_HOST` set (or removed) and restores it.
fn with_docker_host<T>(host: Option<&str>, body: impl FnOnce() -> T) -> T {
    let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let original = std::env::var_os("DOCKER_HOST");
    match host {
        Some(host) => std::env::set_var("DOCKER_HOST", host),
        None => std::env::remove_var("DOCKER_HOST"),
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    match original {
        Some(value) => std::env::set_var("DOCKER_HOST", value),
        None => std::env::remove_var("DOCKER_HOST"),
    }
    result.unwrap_or_else(|payload| std::panic::resume_unwind(payload))
}

#[test]
fn attributes_two_containers_that_finished_in_the_same_second_to_the_daemon() {
    let runner = runner(&together());
    let line = with_docker_host(None, || {
        collect("task", "", FINISHED, "137", "false", &runner)
    });
    assert_eq!(line, DAEMON_RESTART_API);
    let calls = runner.calls.borrow();
    assert!(calls
        .iter()
        .any(|call| call[1..] == ["ps", "-a", "-q", "--no-trunc"]));
    // The task itself is never its own witness.
    let inspect = calls
        .iter()
        .find(|call| call[1] == "inspect" && call[3] != "{{.Id}}")
        .unwrap();
    assert_eq!(inspect[4..], [peer()]);
    assert_eq!(
        resolve_exit_reason(Some(137), Some(&line), Some(false), Some(2)).as_deref(),
        Some("killed (docker daemon restart)")
    );
}

#[test]
fn reports_which_source_supported_the_attribution() {
    assert_eq!(
        evidence_json(Some(DAEMON_RESTART_API), false),
        json!({"mainOom": false, "daemonRestart": true, "daemonRestartSource": "api"})
    );
    assert_eq!(
        evidence_json(Some(DAEMON_RESTART), false),
        json!({"mainOom": false, "daemonRestart": true, "daemonRestartSource": "journal"})
    );
    assert_eq!(from_log(Some(MAIN_OOM)), (true, false));
    assert_eq!(
        evidence_json(Some(MAIN_OOM), true),
        json!({"mainOom": true, "daemonRestart": false})
    );
}

#[test]
fn counts_a_container_restarted_after_it_finished_whose_exit_code_was_reset() {
    let restarted = state(
        &peer(),
        "2026-10-21T10:04:52Z",
        "2026-10-21T10:05:20Z",
        0,
        "false",
    );
    assert!(daemon_restart_api_evidence(&restarted, &task(), FINISHED));
}

#[test]
fn does_not_attribute_unrelated_container_states() {
    for (name, peer_state) in [
        (
            "an OOM-killed peer",
            state(&peer(), FINISHED, "2026-10-21T09:00:00Z", 137, "true"),
        ),
        (
            "a peer that finished 30 s apart",
            state(
                &peer(),
                "2026-10-21T10:05:30.2Z",
                "2026-10-21T09:00:00Z",
                137,
                "false",
            ),
        ),
        (
            "a peer that exited on its own",
            state(&peer(), FINISHED, "2026-10-21T09:00:00Z", 0, "false"),
        ),
        (
            "a peer that never ran",
            state(
                &peer(),
                "0001-01-01T00:00:00Z",
                "0001-01-01T00:00:00Z",
                0,
                "false",
            ),
        ),
        (
            "only the task itself",
            state(&task(), FINISHED, "2026-10-21T09:00:00Z", 137, "false"),
        ),
        ("malformed output", "Error: No such object: gone".into()),
    ] {
        assert!(
            !daemon_restart_api_evidence(&peer_state, &task(), FINISHED),
            "{}",
            name
        );
        let runner = runner(&peer_state);
        let line = with_docker_host(None, || {
            collect("task", "", FINISHED, "137", "false", &runner)
        });
        assert_eq!(line, UNAVAILABLE, "{}", name);
    }
}

#[test]
fn also_works_for_a_remote_daemon_where_no_journal_is_consulted() {
    let runner = runner(&together());
    let line = with_docker_host(Some("tcp://docker.example:2376"), || {
        collect("task", "", FINISHED, "137", "false", &runner)
    });
    assert_eq!(line, DAEMON_RESTART_API);
    assert!(!runner
        .calls
        .borrow()
        .iter()
        .any(|call| call[0] == "journalctl"));
}

#[test]
fn keeps_attempt_scoped_oom_evidence_ahead_of_the_api_check() {
    let runner = runner(&together());
    let line = with_docker_host(None, || {
        collect(
            "task",
            "64 63 3 2 1792577100 1792577100",
            FINISHED,
            "137",
            "true",
            &runner,
        )
    });
    assert_eq!(line, MAIN_OOM);
    assert!(!runner.calls.borrow().iter().any(|call| call[1] == "ps"));
}

#[cfg(unix)]
#[test]
fn status_collects_evidence_the_lost_watcher_never_wrote() {
    use start_command::{query_status, ExecutionRecord, ExecutionStore, ExecutionStoreOptions};
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::TempDir::new().unwrap();
    let docker = dir.path().join("docker");
    std::fs::write(
        &docker,
        [
            "#!/bin/sh".to_string(),
            "case \"$1 $3\" in".into(),
            format!("  \"inspect {{{{.Id}}}}\") echo {} ;;", task()),
            format!(
                "  \"inspect {{{{.Id}}}} \"*) echo '{}' ;;",
                state(
                    &peer(),
                    "2026-10-21T10:05:00.9Z",
                    "2026-10-21T10:05:30Z",
                    0,
                    "false"
                )
            ),
            format!(
                "  \"inspect \"*) echo 'false 137 false 2026-10-21T10:00:00Z {}' ;;",
                FINISHED
            ),
            format!("  \"ps \"*) printf '%s\\n' {} {} ;;", task(), peer()),
            "  \"events \"*) ;;".into(),
            "  *) exit 1 ;;".into(),
            "esac".into(),
            String::new(),
        ]
        .join("\n"),
    )
    .unwrap();
    // No host journal, as inside a container with a mounted docker.sock.
    let journalctl = dir.path().join("journalctl");
    std::fs::write(&journalctl, "#!/bin/sh\nexit 1\n").unwrap();
    for file in [&docker, &journalctl] {
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.path().into()),
        use_links: Some(false),
        verbose: false,
    });
    let mut record = ExecutionRecord::new("sleep 600");
    record.options.insert("isolated".into(), json!("docker"));
    record
        .options
        .insert("isolationMode".into(), json!("detached"));
    record
        .options
        .insert("sessionName".into(), json!("task-241"));
    let log = dir.path().join("task.log");
    // The watcher died before it could log anything after the output.
    std::fs::write(&log, "working\n").unwrap();
    record.log_path = log.to_string_lossy().into_owned();
    store.save(&record).unwrap();

    let status = with_docker_host(None, || {
        let saved_bin = std::env::var_os("START_DOCKER_BIN");
        let saved_path = std::env::var_os("PATH").unwrap_or_default();
        std::env::set_var("START_DOCKER_BIN", &docker);
        let mut paths = vec![dir.path().to_path_buf()];
        paths.extend(std::env::split_paths(&saved_path));
        std::env::set_var("PATH", std::env::join_paths(paths).unwrap());
        let result =
            std::panic::catch_unwind(|| query_status(Some(&store), &record.uuid, Some("json")));
        match saved_bin {
            Some(value) => std::env::set_var("START_DOCKER_BIN", value),
            None => std::env::remove_var("START_DOCKER_BIN"),
        }
        std::env::set_var("PATH", saved_path);
        result.unwrap_or_else(|payload| std::panic::resume_unwind(payload))
    });
    assert!(status.success, "{:?}", status.error);
    let status: serde_json::Value = serde_json::from_str(&status.output.unwrap()).unwrap();
    assert_eq!(status["status"], "executed");
    assert_eq!(status["exitCode"], 137);
    assert_eq!(status["exitReason"], "killed (docker daemon restart)");
    assert_eq!(
        status["options"]["exitEvidence"],
        json!({"mainOom": false, "daemonRestart": true, "daemonRestartSource": "api"})
    );
}
