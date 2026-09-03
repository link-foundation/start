//! Tests for `--resume` (issue #162).

use super::*;
use crate::execution_control::CommandRunOutput;
use crate::execution_store::ExecutionStoreOptions;
use crate::isolation::IsolationResult;
use std::cell::RefCell;
use tempfile::TempDir;

fn make_record() -> ExecutionRecord {
    let mut record = ExecutionRecord::new("npm test");
    record.uuid = "11111111-2222-3333-4444-555555555555".to_string();
    record.log_path = "/tmp/session.log".to_string();
    for (key, value) in [
        ("isolated", json!("docker")),
        ("isolationMode", json!("detached")),
        ("sessionName", json!("box")),
        ("image", json!("ubuntu:24.04")),
    ] {
        record.options.insert(key.to_string(), value);
    }
    record
}

fn probe_with(state: SessionState, container_status: Option<&str>) -> SessionProbe {
    SessionProbe {
        backend: Some("docker".to_string()),
        session_name: Some("box".to_string()),
        state,
        alive: state == SessionState::Running,
        container_status: container_status.map(str::to_string),
    }
}

#[test]
fn build_snapshot_image_name_produces_a_lowercase_docker_safe_tag() {
    assert_eq!(
        build_snapshot_image_name("My_Session Name", 2),
        "start-command-resume/my_session-name:2"
    );
}

#[test]
fn build_resumed_session_name_appends_the_resume_counter() {
    assert_eq!(build_resumed_session_name("box", 3), "box-resume-3");
}

#[test]
fn refuses_to_resume_a_live_session_and_points_at_attach() {
    let error = build_resume_plan(
        &make_record(),
        None,
        &probe_with(SessionState::Running, Some("running")),
    )
    .unwrap_err();
    assert!(error.contains("still running"), "{}", error);
    assert!(error.contains("--attach"), "{}", error);
}

#[test]
fn restarts_a_stopped_container_with_the_stored_command() {
    let plan = build_resume_plan(
        &make_record(),
        None,
        &probe_with(SessionState::Stopped, Some("exited")),
    )
    .unwrap();
    assert_eq!(plan.mode, ResumeMode::DockerStart);
    assert_eq!(plan.session_name, "box");
    assert_eq!(plan.steps[0].args, vec!["start", "box"]);
    assert_eq!(plan.command, "npm test");
}

#[test]
fn snapshots_a_stopped_container_to_run_a_new_command() {
    let plan = build_resume_plan(
        &make_record(),
        Some("npm run build"),
        &probe_with(SessionState::Stopped, Some("exited")),
    )
    .unwrap();
    assert_eq!(plan.mode, ResumeMode::DockerSnapshot);
    assert_eq!(
        plan.snapshot_image.as_deref(),
        Some("start-command-resume/box:1")
    );
    assert_eq!(plan.new_session_name.as_deref(), Some("box-resume-1"));
    assert_eq!(
        plan.steps[0].args,
        vec!["commit", "box", "start-command-resume/box:1"]
    );
    let run_args = &plan.steps[1].args;
    assert_eq!(run_args[0..4], ["run", "-d", "--name", "box-resume-1"]);
    assert_eq!(
        run_args[run_args.len() - 4..],
        ["start-command-resume/box:1", "sh", "-c", "npm run build"]
    );
}

#[test]
fn carries_stored_docker_runtime_options_into_the_snapshot_run() {
    let mut record = make_record();
    for (key, value) in [
        ("privileged", json!(true)),
        ("env", json!(["A=1"])),
        ("volumes", json!(["/host:/container"])),
        ("networks", json!(["testnet"])),
    ] {
        record.options.insert(key.to_string(), value);
    }
    let plan = build_resume_plan(
        &record,
        Some("echo hi"),
        &probe_with(SessionState::Stopped, Some("exited")),
    )
    .unwrap();
    let run_args = &plan.steps[1].args;
    for expected in ["--privileged", "/host:/container", "A=1", "testnet"] {
        assert!(
            run_args.iter().any(|arg| arg == expected),
            "missing {} in {:?}",
            expected,
            run_args
        );
    }
}

#[test]
fn increments_the_counter_across_repeated_resumes() {
    let mut record = make_record();
    record.options.insert("resumeCount".to_string(), json!(2));
    let plan = build_resume_plan(
        &record,
        Some("echo hi"),
        &probe_with(SessionState::Stopped, Some("exited")),
    )
    .unwrap();
    assert_eq!(
        plan.snapshot_image.as_deref(),
        Some("start-command-resume/box:3")
    );
    assert_eq!(plan.new_session_name.as_deref(), Some("box-resume-3"));
}

#[test]
fn relaunches_when_the_container_is_gone() {
    let plan = build_resume_plan(
        &make_record(),
        None,
        &probe_with(SessionState::Missing, None),
    )
    .unwrap();
    assert_eq!(plan.mode, ResumeMode::Relaunch);
    assert_eq!(plan.session_name, "box");
    assert_eq!(plan.command, "npm test");
    let launch = plan.launch_options.unwrap();
    assert_eq!(launch.image.as_deref(), Some("ubuntu:24.04"));
    assert!(launch.detached);
    assert_eq!(
        launch
            .log_path
            .as_deref()
            .map(std::path::Path::to_string_lossy),
        Some(std::borrow::Cow::Borrowed("/tmp/session.log"))
    );
}

#[test]
fn relaunches_a_dead_screen_session() {
    let mut record = make_record();
    record
        .options
        .insert("isolated".to_string(), json!("screen"));
    record
        .options
        .insert("sessionName".to_string(), json!("work"));
    let probe = SessionProbe {
        backend: Some("screen".to_string()),
        session_name: Some("work".to_string()),
        state: SessionState::Missing,
        alive: false,
        container_status: None,
    };
    let plan = build_resume_plan(&record, None, &probe).unwrap();
    assert_eq!(plan.mode, ResumeMode::Relaunch);
    assert_eq!(plan.backend, "screen");

    let with_command = build_resume_plan(&record, Some("echo hi"), &probe).unwrap();
    assert_eq!(with_command.command, "echo hi");
}

#[test]
fn rejects_records_without_a_session_name() {
    let mut record = make_record();
    record.options.remove("sessionName");
    let error =
        build_resume_plan(&record, None, &probe_with(SessionState::Missing, None)).unwrap_err();
    assert!(
        error.contains("does not contain an isolation session name"),
        "{}",
        error
    );
}

#[test]
fn rejects_non_detached_executions() {
    let mut record = make_record();
    record
        .options
        .insert("isolationMode".to_string(), json!("attached"));
    let error =
        build_resume_plan(&record, None, &probe_with(SessionState::Stopped, None)).unwrap_err();
    assert!(
        error.contains("Only detached isolated executions"),
        "{}",
        error
    );
}

#[test]
fn rejects_records_with_no_command_to_resume() {
    let mut record = make_record();
    record.command = String::new();
    let error =
        build_resume_plan(&record, None, &probe_with(SessionState::Missing, None)).unwrap_err();
    assert!(error.contains("no stored command"), "{}", error);
}

#[test]
fn format_resume_result_emits_a_nested_links_notation_block() {
    let output = format_resume_result_as_links_notation(&ResumeResultFields {
        identifier: "box",
        uuid: "u-1",
        mode: ResumeMode::DockerStart,
        backend: "docker",
        session_name: "box",
        previous_session_name: None,
        snapshot_image: None,
        command: "npm test",
        message: "Resumed detached docker container: box",
    });
    assert!(output.starts_with("executionResume\n"));
    assert!(output.contains("\n  mode docker-start\n"));
}

// --- resume_execution ---

/// Reports the container state the test wants, then records the plan steps.
struct ScriptedRunner {
    container_status: &'static str,
    step_success: bool,
    calls: RefCell<Vec<Vec<String>>>,
}

impl ScriptedRunner {
    fn new(container_status: &'static str) -> Self {
        ScriptedRunner {
            container_status,
            step_success: true,
            calls: RefCell::new(Vec::new()),
        }
    }

    fn failing(container_status: &'static str) -> Self {
        ScriptedRunner {
            container_status,
            step_success: false,
            calls: RefCell::new(Vec::new()),
        }
    }
}

impl CommandRunner for ScriptedRunner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        if args.first().map(String::as_str) == Some("inspect") {
            // "missing" means `docker inspect` itself fails: no such container.
            let found = self.container_status != "missing";
            return CommandRunOutput {
                success: found,
                stdout: if found {
                    format!("{}\n", self.container_status)
                } else {
                    String::new()
                },
                stderr: if found {
                    String::new()
                } else {
                    "No such object: box".to_string()
                },
                status: Some(if found { 0 } else { 1 }),
                error: None,
            };
        }
        let mut call = vec![command.to_string()];
        call.extend(args.iter().cloned());
        self.calls.borrow_mut().push(call);
        if self.step_success {
            CommandRunOutput {
                success: true,
                stdout: "deadbeef\n".to_string(),
                stderr: String::new(),
                status: Some(0),
                error: None,
            }
        } else {
            CommandRunOutput {
                success: false,
                stdout: String::new(),
                stderr: "no such container".to_string(),
                status: Some(1),
                error: None,
            }
        }
    }
}

#[derive(Default)]
struct RecordingHooks {
    watchers: RefCell<Vec<String>>,
    launches: RefCell<Vec<(String, String, IsolationOptions)>>,
    relaunch_result: Option<IsolationResult>,
}

impl ResumeHooks for RecordingHooks {
    fn start_watcher(&self, session_name: &str, _record: &ExecutionRecord) {
        self.watchers.borrow_mut().push(session_name.to_string());
    }

    fn relaunch(
        &self,
        backend: &str,
        command: &str,
        options: &IsolationOptions,
    ) -> IsolationResult {
        self.launches.borrow_mut().push((
            backend.to_string(),
            command.to_string(),
            options.clone(),
        ));
        self.relaunch_result
            .clone()
            .unwrap_or_else(|| IsolationResult {
                success: true,
                container_id: Some("newid".to_string()),
                ..Default::default()
            })
    }

    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        record.clone()
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
fn resume_execution_reports_disabled_tracking() {
    let result = resume_execution_with(
        None,
        "box",
        None,
        None,
        &ScriptedRunner::new("exited"),
        &RecordingHooks::default(),
    );
    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("Execution tracking is disabled"));
}

#[test]
fn resume_execution_reports_an_unknown_identifier() {
    let temp = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp.path().to_path_buf()),
        ..Default::default()
    });
    let result = resume_execution_with(
        Some(&store),
        "nope",
        None,
        None,
        &ScriptedRunner::new("exited"),
        &RecordingHooks::default(),
    );
    assert!(!result.success);
    assert!(result.error.unwrap().contains("No execution found"));
}

#[test]
fn resume_execution_starts_a_stopped_container_and_reattaches_the_watcher() {
    let record = make_record();
    let (_temp, store) = store_with(&record);
    let runner = ScriptedRunner::new("exited");
    let hooks = RecordingHooks::default();
    let result = resume_execution_with(Some(&store), "box", None, None, &runner, &hooks);
    assert!(result.success, "{:?}", result.error);
    assert_eq!(
        runner.calls.borrow().clone(),
        vec![vec![
            "docker".to_string(),
            "start".to_string(),
            "box".to_string()
        ]]
    );
    assert_eq!(hooks.watchers.borrow().clone(), vec!["box".to_string()]);

    let saved = store.get(&record.uuid).unwrap();
    assert_eq!(saved.status, ExecutionStatus::Executing);
    assert_eq!(
        saved.options.get("resumeCount").and_then(|v| v.as_u64()),
        Some(1)
    );
}

#[test]
fn resume_execution_keeps_the_same_uuid_and_remembers_the_previous_session_name() {
    let record = make_record();
    let (_temp, store) = store_with(&record);
    let result = resume_execution_with(
        Some(&store),
        "box",
        Some("npm run build"),
        None,
        &ScriptedRunner::new("exited"),
        &RecordingHooks::default(),
    );
    assert!(result.success, "{:?}", result.error);

    let saved = store.get(&record.uuid).unwrap();
    assert_eq!(saved.uuid, record.uuid);
    assert_eq!(saved.command, "npm run build");
    assert_eq!(
        saved.options.get("sessionName").and_then(|v| v.as_str()),
        Some("box-resume-1")
    );
    assert_eq!(
        saved.options.get("sessionNameHistory"),
        Some(&json!(["box"]))
    );
    assert_eq!(
        saved.options.get("containerId").and_then(|v| v.as_str()),
        Some("deadbeef")
    );
    assert_eq!(saved.exit_code, None);
    assert_eq!(saved.end_time, None);

    // The previous session name still addresses the same logical execution.
    assert_eq!(store.get("box").map(|r| r.uuid), Some(record.uuid));
}

#[test]
fn resume_execution_fails_when_a_docker_step_fails() {
    let record = make_record();
    let (_temp, store) = store_with(&record);
    let result = resume_execution_with(
        Some(&store),
        "box",
        None,
        None,
        &ScriptedRunner::failing("exited"),
        &RecordingHooks::default(),
    );
    assert!(!result.success);
    assert!(result.error.unwrap().contains("no such container"));
    assert_eq!(
        store
            .get(&record.uuid)
            .and_then(|r| r.options.get("resumeCount").cloned()),
        None
    );
}

#[test]
fn resume_execution_relaunches_through_the_isolation_backend_when_the_container_is_gone() {
    let record = make_record();
    let (_temp, store) = store_with(&record);
    // A failed `docker inspect` means the container is gone.
    let runner = ScriptedRunner::failing("missing");
    let hooks = RecordingHooks::default();
    let result = resume_execution_with(Some(&store), "box", None, None, &runner, &hooks);
    assert!(result.success, "{:?}", result.error);

    let launches = hooks.launches.borrow();
    assert_eq!(launches.len(), 1);
    assert_eq!(launches[0].0, "docker");
    assert_eq!(launches[0].1, "npm test");
    assert_eq!(launches[0].2.session.as_deref(), Some("box"));
    assert_eq!(store.get(&record.uuid).map(|r| r.uuid), Some(record.uuid));
}

#[test]
fn resume_execution_surfaces_relaunch_failures() {
    let record = make_record();
    let (_temp, store) = store_with(&record);
    let hooks = RecordingHooks {
        relaunch_result: Some(IsolationResult {
            success: false,
            message: "docker is not running".to_string(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let result = resume_execution_with(
        Some(&store),
        "box",
        None,
        None,
        &ScriptedRunner::failing("missing"),
        &hooks,
    );
    assert!(!result.success);
    assert!(result.error.unwrap().contains("docker is not running"));
}
