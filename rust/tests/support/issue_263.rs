//! Fixtures shared by the issue #263 (`--pause`/`--unpause`) regression tests.
#![allow(dead_code)]

use serde_json::{json, Value};
use start_command::execution_pause::{PauseRequest, PAUSE_STATE_FORMAT};
use start_command::{
    CommandRunOutput, CommandRunner, ExecutionRecord, ExecutionRecordOptions, ExecutionStatus,
    ExecutionStore, ExecutionStoreOptions,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;
use tempfile::TempDir;

pub const UUID: &str = "26300000-0000-4000-8000-000000000263";
pub const NAME: &str = "paused-263";

pub fn make_store() -> (TempDir, ExecutionStore) {
    let dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    (dir, store)
}

pub fn record_with(
    extra: &[(&str, Value)],
    status: ExecutionStatus,
    exit_code: Option<i32>,
) -> ExecutionRecord {
    let mut options: HashMap<String, Value> = [
        ("isolated", json!("docker")),
        ("isolationMode", json!("detached")),
        ("sessionName", json!(NAME)),
        ("image", json!("alpine:3.23")),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value))
    .collect();
    for (key, value) in extra {
        options.insert(key.to_string(), value.clone());
    }
    ExecutionRecord::with_options(ExecutionRecordOptions {
        uuid: Some(UUID.to_string()),
        command: "sleep 300".to_string(),
        pid: Some(999_999),
        status: Some(status),
        exit_code,
        log_path: Some(
            std::env::temp_dir()
                .join(format!("start-263-{}.log", std::process::id()))
                .to_string_lossy()
                .to_string(),
        ),
        start_time: Some(chrono::Utc::now().to_rfc3339()),
        options: Some(options),
        ..Default::default()
    })
}

pub fn make_record(extra: &[(&str, Value)]) -> ExecutionRecord {
    record_with(extra, ExecutionStatus::Executing, None)
}

pub fn paused_extra() -> Vec<(&'static str, Value)> {
    vec![
        ("paused", json!(true)),
        ("pausedAt", json!("2026-11-13T08:01:00Z")),
    ]
}

/// In-memory docker: `state` is running, paused, exited or removed. Answers
/// the pause probe, `pause`/`unpause`/`stop`/`kill`/`rm`, and records every
/// call with the timeout it was given (`None`: unbounded).
pub struct FakeDocker {
    pub state: RefCell<String>,
    pub calls: RefCell<Vec<(Vec<String>, Option<Duration>)>>,
    pub fail_pause: bool,
}

impl FakeDocker {
    pub fn new(state: &str) -> Self {
        FakeDocker {
            state: RefCell::new(state.to_string()),
            calls: RefCell::new(Vec::new()),
            fail_pause: false,
        }
    }

    pub fn state(&self) -> String {
        self.state.borrow().clone()
    }

    pub fn ran(&self, verb: &str) -> Vec<Vec<String>> {
        self.calls
            .borrow()
            .iter()
            .filter(|(args, _)| args.first().map(String::as_str) == Some(verb))
            .map(|(args, _)| args.clone())
            .collect()
    }

    fn answer(&self, args: &[String]) -> CommandRunOutput {
        let ok = |stdout: String| CommandRunOutput {
            success: true,
            stdout,
            status: Some(0),
            ..Default::default()
        };
        let fail = |stderr: String| CommandRunOutput {
            success: false,
            stderr,
            status: Some(1),
            ..Default::default()
        };
        let state = self.state();
        let verb = args.first().map(String::as_str).unwrap_or_default();
        if state == "removed" && verb != "rm" {
            return fail(format!(
                "Error response from daemon: No such container: {NAME}"
            ));
        }
        let alive = state == "running" || state == "paused";
        match verb {
            "inspect" => {
                let format = args
                    .iter()
                    .position(|arg| arg == "-f")
                    .and_then(|i| args.get(i + 1))
                    .cloned()
                    .unwrap_or_default();
                match format.as_str() {
                    PAUSE_STATE_FORMAT => ok(format!("{} {}\n", state, state == "paused")),
                    "{{.State.Status}}" => ok(format!("{state}\n")),
                    "{{.Id}} {{.State.Pid}}" => {
                        ok(format!("abc263def {}\n", if alive { 4242 } else { 0 }))
                    }
                    _ => ok(String::new()),
                }
            }
            "pause" if self.fail_pause => fail("boom".into()),
            "pause" if state != "running" => fail(format!("container {NAME} is not running")),
            "unpause" if state != "paused" => fail(format!("container {NAME} is not paused")),
            "rm" if state == "paused" => fail("cannot remove a paused container".into()),
            "pause" | "unpause" | "stop" | "kill" | "rm" => {
                *self.state.borrow_mut() = match verb {
                    "pause" => "paused",
                    "unpause" => "running",
                    "rm" => "removed",
                    _ => "exited",
                }
                .to_string();
                ok(format!("{NAME}\n"))
            }
            _ => ok(String::new()),
        }
    }
}

impl CommandRunner for FakeDocker {
    fn run(&self, _command: &str, args: &[String]) -> CommandRunOutput {
        self.calls.borrow_mut().push((args.to_vec(), None));
        self.answer(args)
    }

    fn run_with_timeout(
        &self,
        _command: &str,
        args: &[String],
        timeout: Duration,
    ) -> CommandRunOutput {
        self.calls.borrow_mut().push((args.to_vec(), Some(timeout)));
        self.answer(args)
    }
}

pub fn request(output_format: Option<&str>) -> PauseRequest<'_> {
    PauseRequest {
        output_format,
        ..Default::default()
    }
}

pub fn json_output(output: Option<String>) -> Value {
    serde_json::from_str(&output.expect("output")).expect("json output")
}

pub fn saved_options(store: &ExecutionStore) -> HashMap<String, Value> {
    store.get(UUID).expect("record").options
}

/// Asserts that a pause/unpause/attach/resume message mentions `needle`.
///
/// Those messages carry the execution UUID (they point at
/// `--status <uuid>`, `--resume <uuid>` or `--unpause <uuid>`), so the message
/// itself never reaches the failure text: CodeQL's rust/cleartext-logging
/// treats an identifier flowing into a panic (which the test harness writes to
/// its log) as a leak, the same convention as `utils.rs` and
/// `user_manager.rs` (issue #168). The static `what` label says which
/// expectation failed instead.
pub fn assert_mentions(message: &str, needle: &str, what: &'static str) {
    assert!(
        message.contains(needle),
        "expected the message to mention {what}"
    );
}
