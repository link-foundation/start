//! Tests for `--attach` (issue #162).

use super::*;
use serde_json::json;
use std::cell::RefCell;

fn make_record(isolated: Option<&str>, session_name: Option<&str>) -> ExecutionRecord {
    make_record_with_mode(isolated, session_name, "detached")
}

fn make_record_with_mode(
    isolated: Option<&str>,
    session_name: Option<&str>,
    isolation_mode: &str,
) -> ExecutionRecord {
    let mut record = ExecutionRecord::new("sleep 1");
    record.uuid = "11111111-2222-3333-4444-555555555555".to_string();
    record.log_path = "/tmp/session.log".to_string();
    record
        .options
        .insert("isolationMode".to_string(), json!(isolation_mode));
    if let Some(isolated) = isolated {
        record
            .options
            .insert("isolated".to_string(), json!(isolated));
    }
    if let Some(session_name) = session_name {
        record
            .options
            .insert("sessionName".to_string(), json!(session_name));
    }
    record
}

fn running_probe(backend: &str, session_name: &str) -> SessionProbe {
    SessionProbe {
        backend: Some(backend.to_string()),
        session_name: Some(session_name.to_string()),
        state: SessionState::Running,
        alive: true,
        container_status: (backend == "docker").then(|| "running".to_string()),
    }
}

fn dead_probe(backend: &str, session_name: &str, state: SessionState) -> SessionProbe {
    SessionProbe {
        backend: Some(backend.to_string()),
        session_name: Some(session_name.to_string()),
        state,
        alive: false,
        container_status: (state == SessionState::Stopped).then(|| "exited".to_string()),
    }
}

#[test]
fn attaches_to_a_running_docker_container() {
    let record = make_record(Some("docker"), Some("box"));
    let plan = build_attach_plan(&record, false, &running_probe("docker", "box")).unwrap();
    assert_eq!(plan.command, "docker");
    assert_eq!(plan.args, vec!["attach", "box"]);
    assert!(plan.interactive);
    assert_eq!(plan.method, "DOCKER_ATTACH");
}

#[test]
fn follows_docker_logs_in_read_only_mode() {
    let record = make_record(Some("docker"), Some("box"));
    let plan = build_attach_plan(&record, true, &running_probe("docker", "box")).unwrap();
    assert_eq!(plan.args, vec!["logs", "-f", "box"]);
    assert!(!plan.interactive);
    assert_eq!(plan.method, "DOCKER_LOG_FOLLOW");
}

#[test]
fn attaches_to_a_running_screen_session() {
    let record = make_record(Some("screen"), Some("work"));
    let plan = build_attach_plan(&record, false, &running_probe("screen", "work")).unwrap();
    assert_eq!(plan.command, "screen");
    assert_eq!(plan.args, vec!["-r", "work"]);
    assert!(plan.interactive);
}

#[test]
fn follows_the_stored_log_for_a_read_only_screen_attach() {
    let record = make_record(Some("screen"), Some("work"));
    let plan = build_attach_plan(&record, true, &running_probe("screen", "work")).unwrap();
    assert_eq!(plan.command, "tail");
    assert_eq!(plan.args, vec!["-f", "/tmp/session.log"]);
    assert_eq!(plan.method, "LOG_FOLLOW");
}

#[test]
fn uses_tmux_read_only_attach_for_read_only() {
    let record = make_record(Some("tmux"), Some("work"));
    let plan = build_attach_plan(&record, false, &running_probe("tmux", "work")).unwrap();
    assert_eq!(plan.args, vec!["attach-session", "-t", "work"]);
    let read_only = build_attach_plan(&record, true, &running_probe("tmux", "work")).unwrap();
    assert_eq!(read_only.args, vec!["attach-session", "-r", "-t", "work"]);
    assert!(read_only.interactive);
}

#[test]
fn follows_the_log_for_ssh_sessions() {
    let record = make_record(Some("ssh"), Some("remote"));
    let plan = build_attach_plan(
        &record,
        false,
        &dead_probe("ssh", "remote", SessionState::Unknown),
    )
    .unwrap();
    assert_eq!(plan.command, "tail");
    assert_eq!(plan.method, "LOG_FOLLOW");
}

#[test]
fn points_at_resume_when_the_session_is_not_running() {
    let record = make_record(Some("docker"), Some("box"));
    let error = build_attach_plan(
        &record,
        false,
        &dead_probe("docker", "box", SessionState::Stopped),
    )
    .unwrap_err();
    assert!(error.contains("is not running"), "{}", error);
    assert!(error.contains("--resume"), "{}", error);
}

#[test]
fn reports_a_removed_container_distinctly() {
    let record = make_record(Some("docker"), Some("box"));
    let error = build_attach_plan(
        &record,
        false,
        &dead_probe("docker", "box", SessionState::Missing),
    )
    .unwrap_err();
    assert!(error.contains("no longer exists"), "{}", error);
}

#[test]
fn rejects_records_without_a_session_name() {
    let record = make_record(Some("docker"), None);
    let error = build_attach_plan(&record, false, &SessionProbe::default()).unwrap_err();
    assert!(
        error.contains("does not contain an isolation session name"),
        "{}",
        error
    );
}

#[test]
fn rejects_attached_non_detached_executions() {
    let record = make_record_with_mode(Some("docker"), Some("box"), "attached");
    let error = build_attach_plan(&record, false, &running_probe("docker", "box")).unwrap_err();
    assert!(
        error.contains("Only detached isolated executions"),
        "{}",
        error
    );
}

#[test]
fn format_attach_result_emits_a_nested_links_notation_block() {
    let output = format_attach_result_as_links_notation(&AttachResultFields {
        identifier: "box",
        uuid: "u-1",
        backend: "docker",
        session_name: "box",
        method: "DOCKER_ATTACH",
        read_only: false,
        command: "docker attach box",
        message: "Attaching to detached docker container: box",
    });
    assert!(output.starts_with("executionAttach\n"));
    assert!(output.contains("\n  method DOCKER_ATTACH\n"));
    assert!(output.contains("\n  readOnly false\n"));
}

// --- attach_execution ---

use crate::execution_control::CommandRunOutput;
use crate::execution_store::{ExecutionStore, ExecutionStoreOptions};
use tempfile::TempDir;

/// Always reports a running docker container, so `probe_session` resolves
/// without a real docker daemon.
struct RunningDockerRunner;

impl CommandRunner for RunningDockerRunner {
    fn run(&self, _command: &str, _args: &[String]) -> CommandRunOutput {
        CommandRunOutput {
            success: true,
            stdout: "running\n".to_string(),
            stderr: String::new(),
            status: Some(0),
            error: None,
        }
    }
}

struct StoppedDockerRunner;

impl CommandRunner for StoppedDockerRunner {
    fn run(&self, _command: &str, _args: &[String]) -> CommandRunOutput {
        CommandRunOutput {
            success: true,
            stdout: "exited\n".to_string(),
            stderr: String::new(),
            status: Some(0),
            error: None,
        }
    }
}

#[derive(Default)]
struct RecordingInteractiveRunner {
    calls: RefCell<Vec<Vec<String>>>,
}

impl InteractiveRunner for RecordingInteractiveRunner {
    fn run(&self, plan: &AttachPlan) -> InteractiveRunOutput {
        let mut call = vec![plan.command.clone()];
        call.extend(plan.args.iter().cloned());
        self.calls.borrow_mut().push(call);
        InteractiveRunOutput {
            success: true,
            status: Some(0),
            error: None,
        }
    }
}

fn store_with(record: &ExecutionRecord) -> (TempDir, ExecutionStore) {
    let temp = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp.path().to_path_buf()),
        ..Default::default()
    });
    store.save(record).unwrap();
    (temp, store)
}

#[test]
fn attach_execution_reports_a_missing_execution() {
    let temp = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp.path().to_path_buf()),
        ..Default::default()
    });
    let result = attach_execution_with_runners(
        Some(&store),
        "nope",
        false,
        &RunningDockerRunner,
        &RecordingInteractiveRunner::default(),
    );
    assert!(!result.success);
    assert!(result.error.unwrap().contains("No execution found"));
}

#[test]
fn attach_execution_reports_disabled_tracking() {
    let result = attach_execution_with_runners(
        None,
        "nope",
        false,
        &RunningDockerRunner,
        &RecordingInteractiveRunner::default(),
    );
    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("Execution tracking is disabled"));
}

#[test]
fn attach_execution_runs_the_interactive_attach_command() {
    let record = make_record(Some("docker"), Some("box"));
    let (_temp, store) = store_with(&record);
    let interactive = RecordingInteractiveRunner::default();
    let result = attach_execution_with_runners(
        Some(&store),
        "box",
        false,
        &RunningDockerRunner,
        &interactive,
    );
    assert!(result.success, "{:?}", result.error);
    assert_eq!(
        interactive.calls.borrow().clone(),
        vec![vec![
            "docker".to_string(),
            "attach".to_string(),
            "box".to_string()
        ]]
    );
    assert!(result.output.unwrap().contains("attach"));
}

#[test]
fn attach_execution_surfaces_plan_errors() {
    let record = make_record(Some("docker"), Some("box"));
    let (_temp, store) = store_with(&record);
    let result = attach_execution_with_runners(
        Some(&store),
        "box",
        false,
        &StoppedDockerRunner,
        &RecordingInteractiveRunner::default(),
    );
    assert!(!result.success);
    assert!(result.error.unwrap().contains("--resume"));
}
