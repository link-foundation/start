//! Issue #224: the guarded Docker snapshot resume flow (lock wait, exit code
//! 75, `--remove-original-after`, commit progress and `--snapshot-prepare`).
use serde_json::{json, Value};
use start_command::docker_snapshot_safety::{acquire_snapshot_lock_with, SnapshotLockRequest};
use start_command::execution_resume::resume_execution_with_resources;
use start_command::{
    report_result, CommandRunOutput, CommandRunner, ExecutionRecord, ExecutionStatus,
    IsolationOptions, IsolationResult, QueryOutcome, ResumeHooks,
};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
#[path = "support/issue_176.rs"]
mod support;
use support::*;

type Events = Arc<Mutex<Vec<String>>>;

struct Hooks(Events);
impl ResumeHooks for Hooks {
    fn start_watcher(&self, _: &str, _: &ExecutionRecord) {
        self.0.lock().unwrap().push("watcher".into());
    }
    fn relaunch(&self, _: &str, _: &str, _: &IsolationOptions) -> IsolationResult {
        IsolationResult {
            success: true,
            ..Default::default()
        }
    }
    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        record.clone()
    }
}

/// Fake docker of a stopped `box`; the replacement runs unless `died`.
struct Runner {
    docker: FakeRunner,
    events: Events,
    died: bool,
    exec_fails: bool,
    commit_delay: Duration,
}

impl Runner {
    fn new() -> Self {
        Runner {
            docker: FakeRunner::new(json!({})),
            events: Events::default(),
            died: false,
            exec_fails: false,
            commit_delay: Duration::ZERO,
        }
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.docker.calls()
    }

    /// The first two arguments of every docker call, e.g. "start box".
    fn order(&self) -> Vec<String> {
        self.calls()
            .iter()
            .map(|call| call[1..call.len().min(3)].join(" "))
            .collect()
    }

    fn ran(&self, verb: &str) -> bool {
        self.docker.call(verb).is_some()
    }
}

impl CommandRunner for Runner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        let result = self.docker.run(command, args);
        if args.iter().any(|arg| arg == "{{.State.Running}}") {
            self.events.lock().unwrap().push("check running".into());
            return ok(if self.died { "false\n" } else { "true\n" });
        }
        match args[0].as_str() {
            "exec" if self.exec_fails => CommandRunOutput {
                success: false,
                stdout: String::new(),
                stderr: "rm: busy".into(),
                status: Some(1),
                error: None,
            },
            "commit" => {
                std::thread::sleep(self.commit_delay);
                result
            }
            _ => result,
        }
    }
}

fn snapshot_record(dir: &Path, extra: Value) -> (start_command::ExecutionStore, ExecutionRecord) {
    let store = test_store(dir);
    let record = docker_record(
        ExecutionStatus::Executed,
        Some(&dir.join("execution.log")),
        extra,
    );
    store.save(&record).unwrap();
    (store, record)
}

fn resume(
    dir: &Path,
    record: &ExecutionRecord,
    store: &start_command::ExecutionStore,
    runner: &Runner,
    overrides: Value,
) -> start_command::ExecutionResumeResult {
    let mut overrides = overrides;
    if overrides.get("snapshotLockPath").is_none() {
        overrides["snapshotLockPath"] = json!(dir.join("snapshot.lock"));
    }
    resume_execution_with_resources(
        Some(store),
        &record.uuid,
        Some("true"),
        None,
        runner,
        &Hooks(runner.events.clone()),
        &overrides,
    )
}

fn log_of(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("execution.log")).unwrap_or_default()
}

/// Hold the snapshot lock on another thread for `hold`.
fn hold_lock(path: &Path, holder: &'static str, hold: Duration) {
    let (ready, is_ready) = std::sync::mpsc::channel::<()>();
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        let lock = acquire_snapshot_lock_with(&SnapshotLockRequest {
            lock_path: Some(path),
            holder: Some(holder),
            ..Default::default()
        })
        .unwrap();
        ready.send(()).unwrap();
        std::thread::sleep(hold);
        drop(lock);
    });
    is_ready.recv_timeout(Duration::from_secs(10)).unwrap();
}

#[test]
fn serializes_two_resumes_instead_of_failing_the_second() {
    let dir = tempfile::TempDir::new().unwrap();
    let (store, record) = snapshot_record(dir.path(), json!({}));
    let lock = dir.path().join("snapshot.lock");
    hold_lock(&lock, "task-a", Duration::from_millis(1200));
    let runner = Runner::new();
    let started = Instant::now();
    let result = resume(
        dir.path(),
        &record,
        &store,
        &runner,
        json!({"snapshotWait": 10.0}),
    );
    assert!(result.success, "{:?}", result.error);
    assert!(started.elapsed() > Duration::from_millis(900));
    assert!(runner.ran("commit"));
}

#[test]
fn reports_exit_code_75_from_a_busy_lock_without_committing() {
    let dir = tempfile::TempDir::new().unwrap();
    let (store, record) = snapshot_record(dir.path(), json!({}));
    hold_lock(
        &dir.path().join("snapshot.lock"),
        "task-a",
        Duration::from_secs(10),
    );
    let runner = Runner::new();
    let result = resume(dir.path(), &record, &store, &runner, json!({}));
    assert!(!result.success);
    assert_eq!(result.exit_code, Some(75));
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("resume of task-a is in progress"));
    assert!(!runner.ran("commit"));
    assert_eq!(
        store.get(&record.uuid).unwrap().options["sessionName"],
        "box"
    );
    assert_eq!(report_result(QueryOutcome::from(result)), 75);
}

#[test]
fn removes_the_original_only_after_the_window_once_the_watcher_is_attached() {
    let dir = tempfile::TempDir::new().unwrap();
    let (store, record) = snapshot_record(dir.path(), json!({}));
    let runner = Runner::new();
    let started = Instant::now();
    let result = resume(
        dir.path(),
        &record,
        &store,
        &runner,
        json!({"removeOriginal": true, "removeOriginalAfter": 0.2}),
    );
    assert!(result.success, "{:?}", result.error);
    assert!(started.elapsed() >= Duration::from_millis(200));
    assert_eq!(
        *runner.events.lock().unwrap(),
        vec!["watcher".to_string(), "check running".to_string()]
    );
    let running: Vec<Vec<String>> = runner
        .calls()
        .into_iter()
        .filter(|call| call.contains(&"{{.State.Running}}".to_string()))
        .collect();
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].last().unwrap(), "box-resume-1");
    assert_eq!(runner.calls().last().unwrap()[1..], args(&["rm", "box"]));
    assert!(result
        .output
        .unwrap()
        .contains("Stopped original container removed: box"));
}

#[test]
fn keeps_the_original_when_the_replacement_died_within_the_window() {
    let dir = tempfile::TempDir::new().unwrap();
    let (store, record) = snapshot_record(dir.path(), json!({}));
    let runner = Runner {
        died: true,
        ..Runner::new()
    };
    let result = resume(
        dir.path(),
        &record,
        &store,
        &runner,
        json!({"removeOriginal": true, "removeOriginalAfter": 0.05}),
    );
    assert!(result.success, "{:?}", result.error);
    assert!(!runner.ran("rm"));
    assert!(result.output.unwrap().contains(
        "Original container retained: the snapshot container is not running 0s after launch."
    ));
}

#[test]
fn logs_progress_and_the_commit_of_a_real_resume() {
    let dir = tempfile::TempDir::new().unwrap();
    let (store, record) = snapshot_record(dir.path(), json!({}));
    let runner = Runner {
        commit_delay: Duration::from_millis(300),
        ..Runner::new()
    };
    let result = resume(
        dir.path(),
        &record,
        &store,
        &runner,
        json!({"snapshotProgressInterval": 0.05}),
    );
    assert!(result.success, "{:?}", result.error);
    let log = log_of(dir.path());
    assert!(
        log.contains("[Resume] snapshotting box: 0s elapsed (docker commit reports no progress)"),
        "{}",
        log
    );
    assert!(log.contains("[Resume] snapshot of box committed after 0s"));
}

#[test]
fn prepare_starts_execs_kills_and_waits_the_original_before_preflight_and_commit() {
    let dir = tempfile::TempDir::new().unwrap();
    let (store, record) = snapshot_record(dir.path(), json!({}));
    let runner = Runner::new();
    let result = resume(
        dir.path(),
        &record,
        &store,
        &runner,
        json!({"snapshotPrepare": "rm -rf /tmp/cache", "snapshotSizeHint": 1024}),
    );
    assert!(result.success, "{:?}", result.error);
    let order = runner.order();
    let prepare = order.iter().position(|call| call == "start box").unwrap();
    assert_eq!(
        order[prepare..prepare + 4],
        args(&["start box", "exec box", "kill box", "wait box"])
    );
    let exec = runner.docker.call("exec").unwrap();
    assert_eq!(
        exec[1..],
        args(&["exec", "box", "sh", "-c", "rm -rf /tmp/cache"])
    );
    let info = order
        .iter()
        .position(|call| call.starts_with("info"))
        .unwrap();
    let commit = order.iter().position(|call| call == "commit box").unwrap();
    assert!(prepare < info && info < commit, "{:?}", order);
    // The size hint replaces the `docker inspect --size` walk.
    assert!(!runner
        .calls()
        .iter()
        .any(|call| call.contains(&"--size".to_string())));
    assert!(log_of(dir.path()).contains("[Resume] snapshot prepare finished in box"));
}

#[test]
fn prepare_still_kills_the_original_and_snapshots_when_the_command_fails() {
    let dir = tempfile::TempDir::new().unwrap();
    let (store, record) = snapshot_record(dir.path(), json!({}));
    let runner = Runner {
        exec_fails: true,
        ..Runner::new()
    };
    let result = resume(
        dir.path(),
        &record,
        &store,
        &runner,
        json!({"snapshotPrepare": "rm -rf /busy"}),
    );
    assert!(result.success, "{:?}", result.error);
    assert!(runner.ran("kill"));
    assert!(runner.ran("commit"));
    assert!(log_of(dir.path()).contains(
        "[Resume] snapshot prepare failed in box (rm: busy); snapshotting the files as they are"
    ));
}

#[test]
fn prepare_never_runs_for_a_docker_start_resume_which_commits_nothing() {
    let dir = tempfile::TempDir::new().unwrap();
    let (store, record) = snapshot_record(dir.path(), json!({"commandHandoff": true}));
    let runner = Runner::new();
    let result = resume(
        dir.path(),
        &record,
        &store,
        &runner,
        json!({"snapshotPrepare": "rm -rf /tmp/cache"}),
    );
    assert!(result.success, "{:?}", result.error);
    assert!(!runner.ran("exec"));
    assert!(!runner.ran("commit"));
}
