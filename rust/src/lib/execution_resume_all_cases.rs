//! Tests for `--resume-all` (issue #162).

use super::*;
use crate::execution_control::CommandRunOutput;
use crate::execution_store::ExecutionStoreOptions;
use crate::isolation::{IsolationOptions, IsolationResult};
use std::cell::RefCell;
use tempfile::TempDir;

fn make_record(isolated: &str, session_name: &str) -> ExecutionRecord {
    let mut record = ExecutionRecord::new("npm test");
    record.log_path = "/tmp/session.log".to_string();
    for (key, value) in [
        ("isolated", json!(isolated)),
        ("isolationMode", json!("detached")),
        ("sessionName", json!(session_name)),
    ] {
        record.options.insert(key.to_string(), value);
    }
    record
}

fn store_with(records: &[ExecutionRecord]) -> (TempDir, ExecutionStore) {
    let temp = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp.path().to_path_buf()),
        ..Default::default()
    });
    for record in records {
        store.save(record).unwrap();
    }
    (temp, store)
}

/// Answers `docker inspect` / `screen -ls` with a scripted session state.
struct ProbeRunner {
    docker_status: Option<&'static str>,
    screen_list: &'static str,
}

impl ProbeRunner {
    fn docker(status: Option<&'static str>) -> Self {
        ProbeRunner {
            docker_status: status,
            screen_list: "",
        }
    }

    fn screen(list: &'static str) -> Self {
        ProbeRunner {
            docker_status: None,
            screen_list: list,
        }
    }
}

impl CommandRunner for ProbeRunner {
    fn run(&self, command: &str, _args: &[String]) -> CommandRunOutput {
        let (success, stdout) = match command {
            "docker" => match self.docker_status {
                Some(status) => (true, format!("{}\n", status)),
                None => (false, String::new()),
            },
            "screen" => (true, self.screen_list.to_string()),
            _ => (false, String::new()),
        };
        CommandRunOutput {
            success,
            stdout,
            stderr: String::new(),
            status: Some(if success { 0 } else { 1 }),
            error: None,
        }
    }
}

/// Records watcher restarts and answers `reconcile` with a scripted record.
#[derive(Default)]
struct RecordingHooks {
    watchers: RefCell<Vec<String>>,
    reconciled_exit_code: Option<i32>,
}

impl ResumeHooks for RecordingHooks {
    fn start_watcher(&self, session_name: &str, _record: &ExecutionRecord) {
        self.watchers.borrow_mut().push(session_name.to_string());
    }

    fn relaunch(
        &self,
        _backend: &str,
        _command: &str,
        _options: &IsolationOptions,
    ) -> IsolationResult {
        unreachable!("--resume-all never relaunches commands")
    }

    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        let mut reconciled = record.clone();
        if let Some(exit_code) = self.reconciled_exit_code {
            reconciled.status = ExecutionStatus::Executed;
            reconciled.exit_code = Some(exit_code);
        }
        reconciled
    }
}

#[test]
fn reports_disabled_tracking() {
    let result = resume_all_executions_with(
        None,
        None,
        &ProbeRunner::docker(None),
        &RecordingHooks::default(),
    );
    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("Execution tracking is disabled"));
}

#[test]
fn reports_an_empty_set() {
    let (_temp, store) = store_with(&[]);
    let result = resume_all_executions_with(
        Some(&store),
        None,
        &ProbeRunner::docker(None),
        &RecordingHooks::default(),
    );
    assert!(result.success);
    assert!(result.output.unwrap().contains("count 0"));
}

#[test]
fn re_attaches_watchers_for_live_docker_sessions() {
    let (_temp, store) = store_with(&[make_record("docker", "box")]);
    let hooks = RecordingHooks::default();
    let result = resume_all_executions_with(
        Some(&store),
        None,
        &ProbeRunner::docker(Some("running")),
        &hooks,
    );
    assert!(result.success);
    assert_eq!(hooks.watchers.borrow().clone(), vec!["box".to_string()]);
    assert!(result.output.unwrap().contains("action reattached"));
}

#[test]
fn reconciles_executions_whose_session_is_gone() {
    let record = make_record("docker", "box");
    let (_temp, store) = store_with(std::slice::from_ref(&record));
    let hooks = RecordingHooks {
        reconciled_exit_code: Some(139),
        ..Default::default()
    };
    let result = resume_all_executions_with(Some(&store), None, &ProbeRunner::docker(None), &hooks);
    assert!(result.success);
    let output = result.output.unwrap();
    assert!(output.contains("action reconciled"), "{}", output);
    assert!(output.contains("exitCode 139"), "{}", output);
    assert!(hooks.watchers.borrow().is_empty());

    let saved = store.get(&record.uuid).unwrap();
    assert_eq!(saved.status, ExecutionStatus::Executed);
    assert_eq!(saved.exit_code, Some(139));
}

#[test]
fn reports_sessions_that_cannot_be_finalized() {
    let (_temp, store) = store_with(&[make_record("docker", "box")]);
    let result = resume_all_executions_with(
        Some(&store),
        None,
        &ProbeRunner::docker(None),
        &RecordingHooks::default(),
    );
    let output = result.output.unwrap();
    assert!(output.contains("action unknown"), "{}", output);
    assert!(
        output.contains("no terminal result could be resolved"),
        "{}",
        output
    );
}

#[test]
fn leaves_live_screen_sessions_untouched() {
    let (_temp, store) = store_with(&[make_record("screen", "work")]);
    let hooks = RecordingHooks::default();
    let result = resume_all_executions_with(
        Some(&store),
        None,
        &ProbeRunner::screen("\t12345.work\t(Detached)\n"),
        &hooks,
    );
    let output = result.output.unwrap();
    assert!(output.contains("action running"), "{}", output);
    assert!(hooks.watchers.borrow().is_empty());
}

#[test]
fn reports_backends_that_cannot_be_probed_locally() {
    let (_temp, store) = store_with(&[make_record("ssh", "remote")]);
    let result = resume_all_executions_with(
        Some(&store),
        None,
        &ProbeRunner::docker(None),
        &RecordingHooks::default(),
    );
    let output = result.output.unwrap();
    assert!(output.contains("action unknown"), "{}", output);
    assert!(output.contains("cannot be probed locally"), "{}", output);
}

#[test]
fn formats_the_report_as_text() {
    let (_temp, store) = store_with(&[make_record("docker", "box")]);
    let result = resume_all_executions_with(
        Some(&store),
        Some("text"),
        &ProbeRunner::docker(Some("running")),
        &RecordingHooks::default(),
    );
    let output = result.output.unwrap();
    assert!(output.starts_with("Executions still marked running: 1"));
    assert!(output.contains("REATTACHED"));
    assert!(output.contains("Session Name: box"));
}

#[test]
fn formats_an_empty_report_as_text() {
    let (_temp, store) = store_with(&[]);
    let result = resume_all_executions_with(
        Some(&store),
        Some("text"),
        &ProbeRunner::docker(None),
        &RecordingHooks::default(),
    );
    assert_eq!(
        result.output.unwrap(),
        "No executions are currently marked as running."
    );
}

#[test]
fn formats_the_report_as_json() {
    let (_temp, store) = store_with(&[make_record("docker", "box")]);
    let result = resume_all_executions_with(
        Some(&store),
        Some("json"),
        &ProbeRunner::docker(Some("running")),
        &RecordingHooks::default(),
    );
    let parsed: serde_json::Value = serde_json::from_str(&result.output.unwrap()).unwrap();
    assert_eq!(parsed["count"], json!(1));
    assert_eq!(parsed["executions"][0]["action"], json!("reattached"));
    assert_eq!(parsed["executions"][0]["backend"], json!("docker"));
}
