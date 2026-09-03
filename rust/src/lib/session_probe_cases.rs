//! Tests for session liveness probing (issue #162).

use super::*;
use crate::execution_control::CommandRunOutput;
use serde_json::json;
use std::collections::HashMap;

#[derive(Default)]
struct FakeRunner {
    responses: HashMap<String, CommandRunOutput>,
}

impl FakeRunner {
    fn with_response(mut self, key: &str, stdout: &str) -> Self {
        self.responses.insert(
            key.to_string(),
            CommandRunOutput {
                success: true,
                stdout: stdout.to_string(),
                stderr: String::new(),
                status: Some(0),
                error: None,
            },
        );
        self
    }
}

impl CommandRunner for FakeRunner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        let key = format!("{} {}", command, args.join(" "));
        self.responses
            .get(&key)
            .cloned()
            .unwrap_or(CommandRunOutput {
                success: false,
                stdout: String::new(),
                stderr: String::new(),
                status: Some(1),
                error: None,
            })
    }
}

fn make_record(isolated: &str, session_name: &str) -> ExecutionRecord {
    let mut record = ExecutionRecord::new("sleep 1");
    record
        .options
        .insert("isolationMode".to_string(), json!("detached"));
    record
        .options
        .insert("isolated".to_string(), json!(isolated));
    record
        .options
        .insert("sessionName".to_string(), json!(session_name));
    record
}

const SCREEN_LISTING: &str =
    "There are screens on:\n\t12345.other-session\t(Detached)\n\t67890.my-session\t(Detached)";

#[test]
fn parse_screen_session_state_finds_a_detached_session() {
    assert_eq!(
        parse_screen_session_state(SCREEN_LISTING, "my-session"),
        SessionState::Running
    );
}

#[test]
fn parse_screen_session_state_reports_missing_sessions() {
    assert_eq!(
        parse_screen_session_state(SCREEN_LISTING, "gone"),
        SessionState::Missing
    );
}

#[test]
fn parse_screen_session_state_does_not_match_a_partial_name() {
    assert_eq!(
        parse_screen_session_state(SCREEN_LISTING, "session"),
        SessionState::Missing
    );
}

#[test]
fn map_docker_status_to_state_maps_running() {
    assert_eq!(
        map_docker_status_to_state(Some("running")),
        SessionState::Running
    );
    assert_eq!(
        map_docker_status_to_state(Some("restarting")),
        SessionState::Running
    );
}

#[test]
fn map_docker_status_to_state_maps_exited_and_created_to_stopped() {
    for status in ["exited", "created", "dead"] {
        assert_eq!(
            map_docker_status_to_state(Some(status)),
            SessionState::Stopped
        );
    }
}

#[test]
fn map_docker_status_to_state_maps_empty_to_unknown() {
    assert_eq!(map_docker_status_to_state(Some("")), SessionState::Unknown);
    assert_eq!(map_docker_status_to_state(None), SessionState::Unknown);
}

#[test]
fn probe_session_detects_a_running_docker_container() {
    let record = make_record("docker", "box");
    let runner =
        FakeRunner::default().with_response("docker inspect -f {{.State.Status}} box", "running\n");
    let probe = probe_session(&record, &runner);
    assert_eq!(probe.state, SessionState::Running);
    assert!(probe.alive);
    assert_eq!(probe.container_status.as_deref(), Some("running"));
}

#[test]
fn probe_session_detects_a_stopped_docker_container() {
    let record = make_record("docker", "box");
    let runner =
        FakeRunner::default().with_response("docker inspect -f {{.State.Status}} box", "exited\n");
    let probe = probe_session(&record, &runner);
    assert_eq!(probe.state, SessionState::Stopped);
    assert!(!probe.alive);
}

#[test]
fn probe_session_detects_a_removed_docker_container() {
    let record = make_record("docker", "box");
    let probe = probe_session(&record, &FakeRunner::default());
    assert_eq!(probe.state, SessionState::Missing);
    assert!(!probe.alive);
}

#[test]
fn probe_session_detects_a_live_tmux_session() {
    let record = make_record("tmux", "work");
    let runner = FakeRunner::default().with_response("tmux has-session -t work", "");
    assert_eq!(probe_session(&record, &runner).state, SessionState::Running);
}

#[test]
fn probe_session_detects_a_dead_tmux_session() {
    let record = make_record("tmux", "work");
    assert_eq!(
        probe_session(&record, &FakeRunner::default()).state,
        SessionState::Missing
    );
}

#[test]
fn probe_session_detects_a_live_screen_session() {
    let record = make_record("screen", "work");
    let runner = FakeRunner::default().with_response("screen -ls", "\t4242.work\t(Detached)\n");
    assert_eq!(probe_session(&record, &runner).state, SessionState::Running);
}

#[test]
fn probe_session_reports_ssh_sessions_as_unknown() {
    let record = make_record("ssh", "remote");
    let probe = probe_session(&record, &FakeRunner::default());
    assert_eq!(probe.state, SessionState::Unknown);
    assert!(!probe.alive);
}

#[test]
fn probe_session_reports_records_without_a_session_name_as_unknown() {
    let record = ExecutionRecord::new("sleep 1");
    assert_eq!(
        probe_session(&record, &FakeRunner::default()).state,
        SessionState::Unknown
    );
}
