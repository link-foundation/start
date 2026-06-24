//! Detached execution control helpers.
//!
//! Maps tracked detached execution records back to native isolation backend
//! controls so callers can stop or terminate a running session by UUID or
//! session name.

use crate::execution_store::{ExecutionRecord, ExecutionStore};
use crate::output_blocks::{escape_for_links_notation, format_value_for_links_notation};
use serde_json::{json, Map, Value};
use std::collections::{HashSet, VecDeque};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlAction {
    Stop,
    Terminate,
}

impl ControlAction {
    pub fn as_str(self) -> &'static str {
        match self {
            ControlAction::Stop => "stop",
            ControlAction::Terminate => "terminate",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandRunOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub status: Option<i32>,
    pub error: Option<String>,
}

pub trait CommandRunner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput;
}

#[derive(Debug, Default)]
pub struct SystemCommandRunner;

impl CommandRunner for SystemCommandRunner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        match Command::new(command).args(args).output() {
            Ok(output) => CommandRunOutput {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                status: output.status.code(),
                error: None,
            },
            Err(err) => CommandRunOutput {
                success: false,
                stdout: String::new(),
                stderr: String::new(),
                status: None,
                error: Some(err.to_string()),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlCommand {
    pub command: String,
    pub args: Vec<String>,
    pub method: String,
    pub message: String,
}

pub struct ExecutionControlResult {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}

fn parse_pid(value: &str) -> Option<u32> {
    value.trim().parse::<u32>().ok().filter(|pid| *pid > 0)
}

fn parse_pids(output: &str) -> Vec<u32> {
    output.split_whitespace().filter_map(parse_pid).collect()
}

pub fn parse_screen_pid(screen_list_output: &str, session_name: &str) -> Option<u32> {
    for line in screen_list_output.lines() {
        let first_column = line.split_whitespace().next().unwrap_or("");
        let Some((pid, name)) = first_column.split_once('.') else {
            continue;
        };
        if name == session_name {
            return parse_pid(pid);
        }
    }
    None
}

pub fn collect_descendant_pids_with_runner<R: CommandRunner>(
    root_pid: u32,
    runner: &R,
) -> Vec<u32> {
    let mut descendants = Vec::new();
    let mut seen = HashSet::from([root_pid]);
    let mut queue = VecDeque::from([root_pid]);

    while let Some(parent_pid) = queue.pop_front() {
        let args = vec!["-P".to_string(), parent_pid.to_string()];
        let result = runner.run("pgrep", &args);
        if !result.success && result.stdout.is_empty() {
            continue;
        }

        for child_pid in parse_pids(&result.stdout) {
            if seen.insert(child_pid) {
                descendants.push(child_pid);
                queue.push_back(child_pid);
            }
        }
    }

    descendants
}

pub fn collect_descendant_pids(root_pid: u32) -> Vec<u32> {
    collect_descendant_pids_with_runner(root_pid, &SystemCommandRunner)
}

fn insert_if_present(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        if !matches!(&value, Value::Array(items) if items.is_empty()) {
            map.insert(key.to_string(), value);
        }
    }
}

fn option_value_as_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

pub fn collect_process_ids(record: &ExecutionRecord) -> Option<Value> {
    collect_process_ids_with_runner(record, &SystemCommandRunner)
}

pub fn collect_process_ids_with_runner<R: CommandRunner>(
    record: &ExecutionRecord,
    runner: &R,
) -> Option<Value> {
    let mut process_ids = Map::new();
    insert_if_present(
        &mut process_ids,
        "wrapperPid",
        record.pid.map(|pid| json!(pid)),
    );

    let session_name = record
        .options
        .get("sessionName")
        .and_then(|value| value.as_str());
    let isolated = record
        .options
        .get("isolated")
        .and_then(|value| value.as_str());

    let (Some(session_name), Some(isolated)) = (session_name, isolated) else {
        return (!process_ids.is_empty()).then_some(Value::Object(process_ids));
    };

    match isolated {
        "screen" => {
            let result = runner.run("screen", &["-ls".to_string()]);
            let output = format!("{}{}", result.stdout, result.stderr);
            if let Some(screen_pid) = parse_screen_pid(&output, session_name) {
                insert_if_present(&mut process_ids, "screenPid", Some(json!(screen_pid)));
                insert_if_present(
                    &mut process_ids,
                    "commandPids",
                    Some(json!(collect_descendant_pids_with_runner(
                        screen_pid, runner
                    ))),
                );
            }
        }
        "tmux" => {
            let tmux_pid_args = vec![
                "display-message".to_string(),
                "-p".to_string(),
                "-t".to_string(),
                session_name.to_string(),
                "#{pid}".to_string(),
            ];
            let tmux_pid_result = runner.run("tmux", &tmux_pid_args);
            insert_if_present(
                &mut process_ids,
                "tmuxPid",
                parse_pid(&tmux_pid_result.stdout).map(|pid| json!(pid)),
            );

            let pane_args = vec![
                "list-panes".to_string(),
                "-t".to_string(),
                session_name.to_string(),
                "-F".to_string(),
                "#{pane_pid}".to_string(),
            ];
            let pane_result = runner.run("tmux", &pane_args);
            let pane_pids = parse_pids(&pane_result.stdout);
            insert_if_present(&mut process_ids, "panePids", Some(json!(pane_pids)));

            let mut command_pids = Vec::new();
            let mut seen = HashSet::new();
            for pane_pid in parse_pids(&pane_result.stdout) {
                for command_pid in collect_descendant_pids_with_runner(pane_pid, runner) {
                    if seen.insert(command_pid) {
                        command_pids.push(command_pid);
                    }
                }
            }
            insert_if_present(&mut process_ids, "commandPids", Some(json!(command_pids)));
        }
        "docker" => {
            insert_if_present(
                &mut process_ids,
                "containerId",
                option_value_as_string(record.options.get("containerId")).map(Value::String),
            );
            let inspect_args = vec![
                "inspect".to_string(),
                "-f".to_string(),
                "{{.Id}} {{.State.Pid}}".to_string(),
                session_name.to_string(),
            ];
            let result = runner.run("docker", &inspect_args);
            if result.success && !result.stdout.trim().is_empty() {
                let mut parts = result.stdout.split_whitespace();
                if let Some(container_id) = parts.next() {
                    insert_if_present(
                        &mut process_ids,
                        "containerId",
                        Some(Value::String(container_id.to_string())),
                    );
                }
                if let Some(pid_value) = parts.next().and_then(parse_pid) {
                    insert_if_present(&mut process_ids, "containerPid", Some(json!(pid_value)));
                }
            }
        }
        "ssh" => {
            insert_if_present(
                &mut process_ids,
                "remotePid",
                record.options.get("remotePid").cloned(),
            );
        }
        _ => {}
    }

    (!process_ids.is_empty()).then_some(Value::Object(process_ids))
}

pub fn get_control_command(
    record: &ExecutionRecord,
    action: ControlAction,
) -> Result<ControlCommand, String> {
    let session_name = record
        .options
        .get("sessionName")
        .and_then(|value| value.as_str())
        .ok_or_else(|| {
            "Execution record does not contain an isolation session name.".to_string()
        })?;

    let isolation_mode = record
        .options
        .get("isolationMode")
        .and_then(|value| value.as_str());
    if isolation_mode != Some("detached") {
        return Err("Only detached isolated executions can be stopped or terminated.".to_string());
    }

    let backend = record
        .options
        .get("isolated")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");

    let command = match (action, backend) {
        (ControlAction::Stop, "screen") => ControlCommand {
            command: "screen".to_string(),
            args: vec![
                "-S".to_string(),
                session_name.to_string(),
                "-X".to_string(),
                "stuff".to_string(),
                "\u{3}".to_string(),
            ],
            method: "CTRL_C".to_string(),
            message: format!("Sent CTRL+C to detached screen session: {}", session_name),
        },
        (ControlAction::Stop, "tmux") => ControlCommand {
            command: "tmux".to_string(),
            args: vec![
                "send-keys".to_string(),
                "-t".to_string(),
                session_name.to_string(),
                "C-c".to_string(),
            ],
            method: "CTRL_C".to_string(),
            message: format!("Sent CTRL+C to detached tmux session: {}", session_name),
        },
        (ControlAction::Stop, "docker") => ControlCommand {
            command: "docker".to_string(),
            args: vec!["stop".to_string(), session_name.to_string()],
            method: "DOCKER_STOP".to_string(),
            message: format!(
                "Requested graceful stop for detached docker container: {}",
                session_name
            ),
        },
        (ControlAction::Terminate, "screen") => ControlCommand {
            command: "screen".to_string(),
            args: vec![
                "-S".to_string(),
                session_name.to_string(),
                "-X".to_string(),
                "quit".to_string(),
            ],
            method: "SCREEN_QUIT".to_string(),
            message: format!("Terminated detached screen session: {}", session_name),
        },
        (ControlAction::Terminate, "tmux") => ControlCommand {
            command: "tmux".to_string(),
            args: vec![
                "kill-session".to_string(),
                "-t".to_string(),
                session_name.to_string(),
            ],
            method: "KILL_SESSION".to_string(),
            message: format!("Terminated detached tmux session: {}", session_name),
        },
        (ControlAction::Terminate, "docker") => ControlCommand {
            command: "docker".to_string(),
            args: vec!["kill".to_string(), session_name.to_string()],
            method: "SIGKILL".to_string(),
            message: format!("Terminated detached docker container: {}", session_name),
        },
        (ControlAction::Stop, other) => {
            return Err(format!(
                "Stopping detached {} executions is not supported.",
                other
            ));
        }
        (ControlAction::Terminate, other) => {
            return Err(format!(
                "Terminating detached {} executions is not supported.",
                other
            ));
        }
    };

    Ok(command)
}

fn append_links_array(lines: &mut Vec<String>, values: &[Value], indent: usize) {
    let prefix = " ".repeat(indent);
    if values.is_empty() {
        lines.push(format!("{}()", prefix));
        return;
    }

    lines.push(format!("{}(", prefix));
    for value in values {
        match value {
            Value::Array(nested) => append_links_array(lines, nested, indent + 2),
            Value::Object(map) => {
                for (child_key, child_value) in map {
                    if !child_value.is_null() {
                        append_links_value(lines, child_key, child_value, indent + 2);
                    }
                }
            }
            _ => lines.push(format!(
                "{}{}",
                " ".repeat(indent + 2),
                format_value_for_links_notation(value)
            )),
        }
    }
    lines.push(format!("{})", prefix));
}

fn append_links_value(lines: &mut Vec<String>, key: &str, value: &Value, indent: usize) {
    let prefix = " ".repeat(indent);
    match value {
        Value::Object(map) => {
            lines.push(format!("{}{}", prefix, key));
            for (child_key, child_value) in map {
                if !child_value.is_null() {
                    append_links_value(lines, child_key, child_value, indent + 4);
                }
            }
        }
        Value::Array(values) => {
            lines.push(format!("{}{}", prefix, key));
            append_links_array(lines, values, indent + 2);
        }
        _ => {
            lines.push(format!(
                "{}{} {}",
                prefix,
                key,
                format_value_for_links_notation(value)
            ));
        }
    }
}

pub fn format_control_result_as_links_notation(
    action: ControlAction,
    identifier: &str,
    record: &ExecutionRecord,
    method: &str,
    process_ids: Option<&Value>,
    message: &str,
) -> String {
    let backend = record
        .options
        .get("isolated")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let session_name = record
        .options
        .get("sessionName")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let status = match action {
        ControlAction::Stop => "signal-sent",
        ControlAction::Terminate => "terminated",
    };

    let mut lines = vec![
        "executionControl".to_string(),
        format!("  action {}", escape_for_links_notation(action.as_str())),
        format!("  identifier {}", escape_for_links_notation(identifier)),
        format!("  uuid {}", escape_for_links_notation(&record.uuid)),
        format!("  status {}", escape_for_links_notation(status)),
        format!("  backend {}", escape_for_links_notation(backend)),
        format!("  sessionName {}", escape_for_links_notation(session_name)),
        format!("  method {}", escape_for_links_notation(method)),
    ];

    if let Some(process_ids) = process_ids {
        append_links_value(&mut lines, "processIds", process_ids, 2);
    }

    lines.push(format!("  message {}", escape_for_links_notation(message)));
    lines.join("\n")
}

pub fn control_execution(
    store: Option<&ExecutionStore>,
    identifier: &str,
    action: ControlAction,
) -> ExecutionControlResult {
    control_execution_with_runner(store, identifier, action, &SystemCommandRunner)
}

pub fn control_execution_with_runner<R: CommandRunner>(
    store: Option<&ExecutionStore>,
    identifier: &str,
    action: ControlAction,
    runner: &R,
) -> ExecutionControlResult {
    let Some(store) = store else {
        return ExecutionControlResult {
            success: false,
            output: None,
            error: Some("Execution tracking is disabled.".to_string()),
        };
    };

    let Some(record) = store.get(identifier) else {
        return ExecutionControlResult {
            success: false,
            output: None,
            error: Some(format!(
                "No execution found with UUID or session name: {}",
                identifier
            )),
        };
    };

    let control = match get_control_command(&record, action) {
        Ok(command) => command,
        Err(error) => {
            return ExecutionControlResult {
                success: false,
                output: None,
                error: Some(error),
            }
        }
    };

    let result = runner.run(&control.command, &control.args);
    if !result.success {
        let backend = record
            .options
            .get("isolated")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let session_name = record
            .options
            .get("sessionName")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let detail = if !result.stderr.is_empty() {
            result.stderr
        } else if let Some(error) = result.error {
            error
        } else {
            format!("exit code {}", result.status.unwrap_or(-1))
        };

        return ExecutionControlResult {
            success: false,
            output: None,
            error: Some(format!(
                "Failed to {} {} session \"{}\": {}",
                action.as_str(),
                backend,
                session_name,
                detail
            )),
        };
    }

    let process_ids = collect_process_ids_with_runner(&record, runner);
    let output = format_control_result_as_links_notation(
        action,
        identifier,
        &record,
        &control.method,
        process_ids.as_ref(),
        &control.message,
    );

    ExecutionControlResult {
        success: true,
        output: Some(output),
        error: None,
    }
}
