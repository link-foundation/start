use serde_json::json;
use start_command::execution_control::{CommandRunOutput, CommandRunner};
use start_command::exit_evidence::{self, DOCKER_OOM};
use start_command::exit_reason::{resolve_exit_reason, resolve_memory_exhaustion};
use start_command::{enrich_detached_status, ExecutionRecord, ExecutionStatus};

struct Runner {
    events: &'static str,
    journal: String,
}
impl CommandRunner for Runner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        let stdout = match args.first().map(String::as_str) {
            Some("inspect") => "a".repeat(64),
            Some("events") => {
                assert!(args.contains(&format!("container={}", "a".repeat(64))));
                assert!(args.contains(&"event=oom".into()));
                assert!(args.contains(&"--until".into()));
                self.events.into()
            }
            _ if command == "journalctl" => self.journal.clone(),
            _ => String::new(),
        };
        CommandRunOutput {
            success: !stdout.is_empty(),
            stdout,
            ..Default::default()
        }
    }
}

#[test]
fn final_docker_event_survives_a_stale_child_sample() {
    let line = exit_evidence::collect(
        "task",
        "3135369216 3135373312 1 1 62 62",
        "1970-01-01T00:01:40.592Z",
        "137",
        "true",
        &Runner {
            events: "62\n99\n",
            journal: String::new(),
        },
    );
    assert_eq!(line, DOCKER_OOM);
    assert_eq!(
        resolve_exit_reason(Some(137), Some(&line), Some(true), Some(1)).as_deref(),
        Some("memory-exhaustion (cgroup-oom-killer)")
    );
    assert!(resolve_memory_exhaustion(Some(137), Some(&line), Some(true), Some(1)).is_some());
    assert!(resolve_memory_exhaustion(Some(137), Some(&line), Some(false), None).is_some());
}

#[test]
fn only_recent_valid_events_for_a_sigkill_qualify() {
    for events in ["62", "96", "102", "nope", "", "0", "Infinity"] {
        let line = exit_evidence::collect(
            "task",
            "",
            "1970-01-01T00:01:40.592Z",
            "137",
            "true",
            &Runner {
                events,
                journal: String::new(),
            },
        );
        assert!(!exit_evidence::from_log(Some(&line)).0);
    }
    for exit in ["0", "1", "139", "-1"] {
        let line = exit_evidence::collect(
            "task",
            "",
            "1970-01-01T00:01:40.592Z",
            exit,
            "true",
            &Runner {
                events: "99",
                journal: String::new(),
            },
        );
        assert!(!exit_evidence::from_log(Some(&line)).0);
    }
}

#[test]
fn archive_preserves_evidence_before_options_are_reset() {
    let mut record = ExecutionRecord::new("work");
    record.options.insert(
        "exitEvidence".into(),
        json!({"mainOom":true,"daemonRestart":false}),
    );
    start_command::execution_attempt::archive_attempt(&mut record);
    assert_eq!(
        record.attempt_history[0]["exitEvidence"],
        record.options["exitEvidence"]
    );
}

#[test]
fn finalization_preserves_docker_event_when_the_log_is_removed() {
    use start_command::{
        finalize_detached_execution, DetachedFinalizeFacts, ExecutionStore, ExecutionStoreOptions,
    };
    let dir = tempfile::TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.path().into()),
        use_links: Some(false),
        verbose: false,
    });
    let mut record = ExecutionRecord::new("work");
    record.log_path = dir.path().join("run.log").to_string_lossy().into();
    std::fs::write(&record.log_path, format!("{}\n", DOCKER_OOM)).unwrap();
    store.save(&record).unwrap();
    finalize_detached_execution(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "137".into(),
            oom_killed: "true".into(),
            finished_at: "1970-01-01T00:01:40.592Z".into(),
            cgroup_memory: "3135369216 3135373312 1 1 62 62".into(),
            running: "false".into(),
            ..Default::default()
        },
    );
    let current = store.get(&record.uuid).unwrap();
    assert_eq!(current.options["exitEvidence"]["mainOom"], true);
    std::fs::remove_file(&record.log_path).unwrap();
    assert_eq!(
        enrich_detached_status(&current).memory_exhausted,
        Some(true)
    );
}

#[test]
fn historical_logs_cannot_read_later_attempt_output() {
    let dir = tempfile::TempDir::new().unwrap();
    let first = format!("{}\n", DOCKER_OOM);
    let second = "ordinary exit\n";
    let log = dir.path().join("run.log");
    std::fs::write(
        &log,
        format!(
            "{}{}FATAL ERROR: JavaScript heap out of memory\n",
            first, second
        ),
    )
    .unwrap();
    let mut record = ExecutionRecord::new("work");
    record.status = ExecutionStatus::Executed;
    record.exit_code = Some(1);
    record.log_path = log.to_string_lossy().into();
    record.attempt = Some(
        serde_json::from_value(json!({"number":3,"startedAt":"1970-01-01T00:02:00Z",
        "logOffset": first.len() + second.len(), "lastOutputAt":null,"launchAcceptedAt":null,
        "watcherAttachedAt":null,"mode":"resume","previousSessionName":null,"sessionName":null}))
        .unwrap(),
    );
    record.attempt_history = vec![
        json!({"number":1,"status":"executed","logOffset":0,"exitCode":137,"oomKilled":true}),
        json!({"number":2,"status":"executed","logOffset":first.len(),"exitCode":1,"oomKilled":true}),
    ];
    let result = enrich_detached_status(&record);
    assert_eq!(
        result.attempt_history[0]["exitReason"],
        "memory-exhaustion (cgroup-oom-killer)"
    );
    assert!(result.attempt_history[1].get("memoryExhausted").is_none());
    assert_eq!(
        result.exit_reason.as_deref(),
        Some("memory-exhaustion (v8-heap-limit)")
    );
    assert!(record.attempt_history[0].get("exitReason").is_none());
    record.attempt_history[1]["logOffset"] = serde_json::Value::Null;
    assert_eq!(
        enrich_detached_status(&record).attempt_history[0]["exitReason"],
        "signal (SIGKILL; cause unknown)"
    );
}
