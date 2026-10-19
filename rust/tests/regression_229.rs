//! Issue #229: a new launch with an existing --session-id used to replace the
//! execution record and truncate its log. It is now refused unless
//! --append-attempt is given, which keeps the record and appends the new
//! attempt to the same log. Mirrors js/test/regression-229.js.

#![cfg(unix)]

use start_command::args_parser::parse_args;
use start_command::execution_store::{
    ExecutionRecord, ExecutionRecordOptions, ExecutionStore, ExecutionStoreOptions,
};
use start_command::launch_identity::{
    already_exists_message, claim_launch, merge_appended_attempt, preflight_launch, ClaimError,
    PreflightParams,
};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const UUID: &str = "22900000-0000-4000-8000-000000000229";

struct Sandbox {
    root: tempfile::TempDir,
    disable_tracking: bool,
}

impl Sandbox {
    fn new() -> Self {
        Sandbox {
            root: tempfile::tempdir().unwrap(),
            disable_tracking: false,
        }
    }

    fn app(&self) -> PathBuf {
        self.root.path().join("app")
    }

    fn logs(&self) -> PathBuf {
        self.root.path().join("logs")
    }

    fn run(&self, args: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_start"));
        command
            .args(args)
            .env("START_APP_FOLDER", self.app())
            .env("START_LOG_DIR", self.logs())
            .env("START_DISABLE_AUTO_ISSUE", "1")
            .env("START_DISABLE_LOG_UPLOAD", "1")
            .env_remove("START_EXECUTION_ID")
            .env_remove("START_ATTEMPT")
            .stdin(Stdio::null());
        if self.disable_tracking {
            command.env("START_DISABLE_TRACKING", "1");
        }
        command.output().expect("failed to run the start binary")
    }

    fn store(&self) -> ExecutionStore {
        ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(self.app()),
            use_links: Some(false),
            verbose: false,
        })
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn params<'a>(
    store: Option<&'a ExecutionStore>,
    explicit: bool,
    append: bool,
    log_path: &Path,
) -> PreflightParams<'a> {
    PreflightParams {
        store,
        session_id: UUID,
        explicit_session_id: explicit,
        append_attempt: append,
        log_path: log_path.to_path_buf(),
        env_execution_id: None,
        env_attempt: None,
    }
}

fn record(command: &str, options: HashMap<String, serde_json::Value>) -> ExecutionRecord {
    ExecutionRecord::with_options(ExecutionRecordOptions {
        uuid: Some(UUID.into()),
        command: command.into(),
        options: Some(options),
        ..Default::default()
    })
}

#[test]
fn refuses_a_second_launch_and_keeps_the_first_log_intact() {
    let box_ = Sandbox::new();
    let first = box_.run(&["--session-id", UUID, "--", "echo", "first-run"]);
    assert_eq!(first.status.code(), Some(0), "{}", text(&first.stderr));
    let log_path = box_.store().get(UUID).unwrap().log_path;
    let before = fs::read_to_string(&log_path).unwrap();

    let second = box_.run(&["--session-id", UUID, "--", "echo", "second"]);
    assert_eq!(second.status.code(), Some(1));
    assert!(text(&second.stderr).contains(&already_exists_message(UUID)));
    assert!(!text(&second.stdout).contains("second"));
    assert_eq!(fs::read_to_string(&log_path).unwrap(), before);
    let stored = box_.store().get(UUID).unwrap();
    assert_eq!(stored.command, "echo first-run");
    assert!(stored.attempt_history.is_empty());
}

#[test]
fn append_attempt_keeps_the_record_and_appends_to_the_same_log() {
    let box_ = Sandbox::new();
    box_.run(&["--session-id", UUID, "--", "echo", "first-run"]);
    let log_path = box_.store().get(UUID).unwrap().log_path;
    let first_size = fs::metadata(&log_path).unwrap().len();

    let appended = box_.run(&[
        "--session-id",
        UUID,
        "--append-attempt",
        "--",
        "sh",
        "-c",
        "echo second-run $START_ATTEMPT",
    ]);
    assert_eq!(
        appended.status.code(),
        Some(0),
        "{}",
        text(&appended.stderr)
    );
    assert!(text(&appended.stdout).contains("second-run 2"));

    let log = fs::read_to_string(&log_path).unwrap();
    assert!(log.contains("first-run"));
    assert!(log.contains("second-run 2"));
    assert_eq!(log.matches("=== Start Command Log ===").count(), 2);
    assert!(log.contains("\"event\":\"attempt-appended\""));

    let stored = box_.store().get(UUID).unwrap();
    let attempt = stored.attempt.clone().unwrap();
    assert_eq!(attempt.number, 2);
    assert_eq!(attempt.mode, "append-attempt");
    assert_eq!(attempt.log_offset, Some(first_size));
    assert_eq!(stored.attempt_history.len(), 1);
    let first = &stored.attempt_history[0];
    assert_eq!(first["number"], 1);
    assert_eq!(first["logOffset"], 0);
    assert_eq!(first["command"], "echo first-run");
    assert_eq!(first["exitCode"], 0);
    assert_eq!(stored.log_path, log_path);
}

#[test]
fn refuses_an_id_that_is_the_name_of_another_execution() {
    let box_ = Sandbox::new();
    let other = "22900000-0000-4000-8000-000000000001";
    box_.run(&["--session-id", other, "--", "echo", "x"]);
    assert_eq!(box_.run(&["--alias", other, UUID]).status.code(), Some(0));
    let launch = box_.run(&["--session-id", UUID, "--", "echo", "y"]);
    assert_eq!(launch.status.code(), Some(1));
    assert!(text(&launch.stderr).contains(&format!(
        "execution id {} is already used as a name of execution {}",
        UUID, other
    )));
}

#[test]
fn recognises_an_untracked_execution_by_its_log_file() {
    let mut box_ = Sandbox::new();
    box_.disable_tracking = true;
    let log_path = box_.logs().join("direct").join(format!("{}.log", UUID));
    fs::create_dir_all(log_path.parent().unwrap()).unwrap();
    fs::write(&log_path, "=== Start Command Log ===\nold\n").unwrap();

    let refused = preflight_launch(params(None, true, false, &log_path)).unwrap_err();
    assert_eq!(refused, already_exists_message(UUID));
    let launch = preflight_launch(params(None, true, true, &log_path)).unwrap();
    assert!(launch.append);
    assert_eq!(launch.attempt_number, 2);

    // End to end: the untracked log keeps the first attempt.
    let run = box_.run(&[
        "--session-id",
        UUID,
        "--append-attempt",
        "--",
        "echo",
        "next",
    ]);
    assert_eq!(run.status.code(), Some(0), "{}", text(&run.stderr));
    let log = fs::read_to_string(&log_path).unwrap();
    assert!(log.starts_with("=== Start Command Log ===\nold\n"));
    assert!(log.contains("next"));
}

#[test]
fn refuses_append_attempt_while_the_execution_is_still_running() {
    let box_ = Sandbox::new();
    let store = box_.store();
    let mut running = record("sleep 9", HashMap::new());
    running.pid = Some(std::process::id());
    store.save(&running).unwrap();
    let error =
        preflight_launch(params(Some(&store), true, true, Path::new("/nonexistent"))).unwrap_err();
    assert!(error.contains("is still running"), "{}", error);
}

#[test]
fn lets_the_next_level_of_a_stacked_isolation_reuse_the_id() {
    let box_ = Sandbox::new();
    let store = box_.store();
    store.save(&record("x", HashMap::new())).unwrap();
    let launch = preflight_launch(PreflightParams {
        env_execution_id: Some(UUID.into()),
        env_attempt: Some("3".into()),
        ..params(Some(&store), true, false, Path::new("/nonexistent"))
    })
    .unwrap();
    assert!(launch.nested);
    assert_eq!(launch.attempt_number, 3);
}

#[test]
fn a_generated_id_is_never_checked() {
    let box_ = Sandbox::new();
    let store = box_.store();
    store.save(&record("x", HashMap::new())).unwrap();
    let launch = preflight_launch(params(
        Some(&store),
        false,
        false,
        Path::new("/nonexistent"),
    ))
    .unwrap();
    assert!(!launch.append);
    assert!(!launch.checked);
}

#[test]
fn claim_launch_refuses_a_launch_that_lost_the_race_for_the_id() {
    let box_ = Sandbox::new();
    let store = box_.store();
    let none = box_.root.path().join("none.log");
    let launch = preflight_launch(params(Some(&store), true, false, &none)).unwrap();
    store.save(&record("winner", HashMap::new())).unwrap();
    let result = claim_launch(&store, &record("loser", HashMap::new()), &launch);
    assert!(matches!(result, Err(ClaimError::Refused(_))));
    assert_eq!(store.get(UUID).unwrap().command, "winner");
}

#[test]
fn merge_appended_attempt_keeps_names_continuation_and_history() {
    let mut options = HashMap::new();
    options.insert("sessionName".to_string(), serde_json::json!("old-s"));
    options.insert("aliases".to_string(), serde_json::json!(["a"]));
    options.insert("name".to_string(), serde_json::json!("n"));
    let mut previous = record("old", options);
    previous.log_path = "/nonexistent.log".into();
    previous.continues = Some("22900000-0000-4000-8000-000000000002".into());
    previous.complete(3);
    let mut new_options = HashMap::new();
    new_options.insert("sessionName".to_string(), serde_json::json!("new-s"));
    let mut current = record("new", new_options);

    merge_appended_attempt(&mut current, &previous);
    assert_eq!(current.start_time, previous.start_time);
    assert_eq!(current.continues, previous.continues);
    assert_eq!(current.options["sessionName"], "new-s");
    assert_eq!(
        current.options["sessionNameHistory"],
        serde_json::json!(["old-s"])
    );
    assert_eq!(current.options["aliases"], serde_json::json!(["a"]));
    assert_eq!(current.options["name"], "n");
    assert_eq!(current.attempt.as_ref().unwrap().number, 2);
    assert_eq!(current.attempt_history[0]["number"], 1);
    assert_eq!(current.attempt_history[0]["exitCode"], 3);
    assert_eq!(current.attempt_history[0]["sessionName"], "old-s");
}

#[test]
fn parses_append_attempt_and_requires_session_id() {
    let args = |list: &[&str]| -> Vec<String> { list.iter().map(|s| s.to_string()).collect() };
    let parsed = parse_args(&args(&[
        "--session-id",
        UUID,
        "--append-attempt",
        "--",
        "echo",
    ]))
    .unwrap();
    assert!(parsed.wrapper_options.append_attempt);
    assert_eq!(
        parse_args(&args(&["--append-attempt", "--", "echo"]))
            .err()
            .unwrap(),
        "--append-attempt option requires --session-id <uuid>"
    );
    assert_eq!(
        parse_args(&args(&["--status", UUID, "--append-attempt"]))
            .err()
            .unwrap(),
        "--append-attempt option is only valid when launching a command"
    );
}
