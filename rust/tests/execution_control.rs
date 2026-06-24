//! Tests for detached execution control helpers.

use serde_json::json;
use start_command::{
    collect_process_ids_with_runner, control_execution_with_runner, get_control_command,
    parse_screen_pid, CommandRunOutput, CommandRunner, ControlAction, ExecutionRecord,
    ExecutionRecordOptions, ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
};
use std::cell::RefCell;
use std::collections::HashMap;
use tempfile::TempDir;

#[derive(Default)]
struct FakeRunner {
    calls: RefCell<Vec<(String, Vec<String>)>>,
    responses: HashMap<String, CommandRunOutput>,
}

impl FakeRunner {
    fn with_response(mut self, key: &str, output: CommandRunOutput) -> Self {
        self.responses.insert(key.to_string(), output);
        self
    }

    fn calls(&self) -> Vec<(String, Vec<String>)> {
        self.calls.borrow().clone()
    }
}

impl CommandRunner for FakeRunner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        self.calls
            .borrow_mut()
            .push((command.to_string(), args.to_vec()));
        let key = format!("{} {}", command, args.join(" "));
        self.responses
            .get(&key)
            .cloned()
            .or_else(|| self.responses.get(command).cloned())
            .unwrap_or(CommandRunOutput {
                success: true,
                stdout: String::new(),
                stderr: String::new(),
                status: Some(0),
                error: None,
            })
    }
}

fn success(stdout: &str) -> CommandRunOutput {
    CommandRunOutput {
        success: true,
        stdout: stdout.to_string(),
        stderr: String::new(),
        status: Some(0),
        error: None,
    }
}

fn detached_record(overrides: Option<HashMap<String, serde_json::Value>>) -> ExecutionRecord {
    let mut options = HashMap::from([
        ("isolated".to_string(), json!("screen")),
        ("isolationMode".to_string(), json!("detached")),
        ("sessionName".to_string(), json!("screen-session")),
    ]);
    if let Some(overrides) = overrides {
        options.extend(overrides);
    }

    ExecutionRecord::with_options(ExecutionRecordOptions {
        uuid: Some("control-test-uuid".to_string()),
        command: "sleep 100".to_string(),
        pid: Some(12345),
        status: Some(ExecutionStatus::Executing),
        log_path: Some("/tmp/control-test.log".to_string()),
        options: Some(options),
        ..Default::default()
    })
}

fn store_with_record(record: &ExecutionRecord) -> (TempDir, ExecutionStore) {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    store.save(record).unwrap();
    (temp_dir, store)
}

#[test]
fn screen_stop_maps_to_ctrl_c_injection() {
    let command = get_control_command(&detached_record(None), ControlAction::Stop).unwrap();

    assert_eq!(command.command, "screen");
    assert_eq!(
        command.args,
        vec!["-S", "screen-session", "-X", "stuff", "\u{3}"]
    );
    assert_eq!(command.method, "CTRL_C");
}

#[test]
fn stop_sends_screen_control_command() {
    let (_temp_dir, store) = store_with_record(&detached_record(None));
    let runner = FakeRunner::default()
        .with_response("screen -ls", success("\t111.screen-session\t(Detached)\n"))
        .with_response("pgrep -P 111", success("222\n"));

    let result =
        control_execution_with_runner(Some(&store), "screen-session", ControlAction::Stop, &runner);

    assert!(result.success);
    let output = result.output.unwrap();
    assert!(output.contains("executionControl"));
    assert!(output.contains("action stop"));
    assert!(output.contains("method CTRL_C"));
    assert!(output.contains("screenPid 111"));
    assert_eq!(
        runner.calls()[0],
        (
            "screen".to_string(),
            vec![
                "-S".to_string(),
                "screen-session".to_string(),
                "-X".to_string(),
                "stuff".to_string(),
                "\u{3}".to_string(),
            ],
        )
    );
}

#[test]
fn stop_sends_docker_stop() {
    let record = detached_record(Some(HashMap::from([
        ("isolated".to_string(), json!("docker")),
        ("sessionName".to_string(), json!("docker-session")),
        ("containerId".to_string(), json!("abc123")),
    ])));
    let (_temp_dir, store) = store_with_record(&record);
    let runner = FakeRunner::default().with_response(
        "docker inspect -f {{.Id}} {{.State.Pid}} docker-session",
        success("abcdef 0\n"),
    );

    let result = control_execution_with_runner(
        Some(&store),
        "control-test-uuid",
        ControlAction::Stop,
        &runner,
    );

    assert!(result.success);
    let output = result.output.unwrap();
    assert!(output.contains("action stop"));
    assert!(output.contains("method DOCKER_STOP"));
    assert!(output.contains("containerId abcdef"));
    assert_eq!(
        runner.calls()[0],
        (
            "docker".to_string(),
            vec!["stop".to_string(), "docker-session".to_string()],
        )
    );
}

#[test]
fn terminate_sends_docker_kill() {
    let record = detached_record(Some(HashMap::from([
        ("isolated".to_string(), json!("docker")),
        ("sessionName".to_string(), json!("docker-session")),
        ("containerId".to_string(), json!("abc123")),
    ])));
    let (_temp_dir, store) = store_with_record(&record);
    let runner = FakeRunner::default().with_response(
        "docker inspect -f {{.Id}} {{.State.Pid}} docker-session",
        success("abcdef 444\n"),
    );

    let result = control_execution_with_runner(
        Some(&store),
        "control-test-uuid",
        ControlAction::Terminate,
        &runner,
    );

    assert!(result.success);
    let output = result.output.unwrap();
    assert!(output.contains("action terminate"));
    assert!(output.contains("method SIGKILL"));
    assert!(output.contains("containerPid 444"));
    assert_eq!(
        runner.calls()[0],
        (
            "docker".to_string(),
            vec!["kill".to_string(), "docker-session".to_string()],
        )
    );
}

#[test]
fn non_detached_records_are_rejected() {
    let record = detached_record(Some(HashMap::from([(
        "isolationMode".to_string(),
        json!("attached"),
    )])));
    let (_temp_dir, store) = store_with_record(&record);

    let result = control_execution_with_runner(
        Some(&store),
        "screen-session",
        ControlAction::Stop,
        &FakeRunner::default(),
    );

    assert!(!result.success);
    assert!(result
        .error
        .unwrap()
        .contains("Only detached isolated executions"));
}

#[test]
fn parses_screen_pid_from_screen_ls_output() {
    assert_eq!(
        parse_screen_pid(
            "There is a screen on:\n\t1234.my-session\t(Detached)\n",
            "my-session",
        ),
        Some(1234)
    );
}

#[test]
fn collects_screen_and_descendant_process_ids() {
    let runner = FakeRunner::default()
        .with_response("screen -ls", success("\t111.screen-session\t(Detached)\n"))
        .with_response("pgrep -P 111", success("222\n333\n"))
        .with_response(
            "pgrep -P 222",
            CommandRunOutput {
                success: false,
                stdout: String::new(),
                stderr: String::new(),
                status: Some(1),
                error: None,
            },
        )
        .with_response(
            "pgrep -P 333",
            CommandRunOutput {
                success: false,
                stdout: String::new(),
                stderr: String::new(),
                status: Some(1),
                error: None,
            },
        );

    let process_ids = collect_process_ids_with_runner(&detached_record(None), &runner).unwrap();

    assert_eq!(process_ids["wrapperPid"], 12345);
    assert_eq!(process_ids["screenPid"], 111);
    assert_eq!(process_ids["commandPids"], json!([222, 333]));
}
