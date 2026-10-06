use chrono::Utc;
use serde_json::json;
use start_command::detached_finalize::{
    finalize_detached_execution_with_attempt, DetachedFinalizeFacts,
};
use start_command::detached_output::OutputObserver;
use start_command::execution_attempt::{activity_path, read_attempt_log_tail};
use start_command::execution_resume::resume_execution_with;
use start_command::execution_resume::{apply_resume_to_record, build_resume_plan};
use start_command::status_formatter::{enrich_detached_status, format_record, format_record_list};
use start_command::{ExecutionRecord, ExecutionStatus, SessionProbe, SessionState};
use start_command::{ExecutionStore, IsolationOptions, IsolationResult, ResumeHooks};
use std::fs;
use tempfile::TempDir;

#[path = "support/issue_176.rs"]
mod support;

const OLD_LOG: &str = "previous output: 🐝\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n\n==================================================\nFinished: 2026-01-01 00:01:00.000\nExit Code: 137\n";

fn fixture() -> (TempDir, ExecutionStore, ExecutionRecord) {
    let temp = TempDir::new().unwrap();
    let store = support::test_store(temp.path());
    let mut record = ExecutionRecord::new("worker");
    record.log_path = temp
        .path()
        .join("execution.log")
        .to_string_lossy()
        .into_owned();
    fs::write(&record.log_path, OLD_LOG).unwrap();
    record.start_time = "2026-01-01T00:00:00Z".into();
    record.end_time = Some("2026-01-01T00:01:00Z".into());
    record.status = ExecutionStatus::Executed;
    record.exit_code = Some(137);
    record.end_time_source = Some("docker-finished-at".into());
    record.observed_at = record.end_time.clone();
    record.stale_detected_at = record.end_time.clone();
    record.container_started_at = Some(record.start_time.clone());
    record.oom_killed = Some(true);
    record.exit_reason = Some("cgroup-oom-killer".into());
    record.memory_exhausted = Some(true);
    record.memory_exhausted_reason = Some("cgroup-oom-killer".into());
    record.cgroup_memory = start_command::cgroup_memory::parse_cgroup_memory_sample("128 128 1 1");
    for (key, value) in [
        ("isolated", "docker"),
        ("isolationMode", "detached"),
        ("sessionName", "issue-187-container-that-does-not-exist"),
        ("containerError", "previous error"),
    ] {
        record.options.insert(key.into(), json!(value));
    }
    store.save(&record).unwrap();
    (temp, store, record)
}

struct Hooks<'a> {
    store: &'a ExecutionStore,
    immediate: bool,
    fail: bool,
}

impl ResumeHooks for Hooks<'_> {
    fn start_watcher(&self, _name: &str, record: &ExecutionRecord) {
        let saved = self.store.get(&record.uuid).unwrap();
        assert_eq!(saved.status, ExecutionStatus::Executing);
        assert!(saved.attempt.as_ref().unwrap().launch_accepted_at.is_some());
        if self.immediate {
            let now = Utc::now().to_rfc3339();
            let result = finalize_detached_execution_with_attempt(
                self.store,
                &record.uuid,
                &DetachedFinalizeFacts {
                    exit_code: "0".into(),
                    oom_killed: "false".into(),
                    started_at: now.clone(),
                    finished_at: now,
                    ..Default::default()
                },
                Some(saved.attempt.unwrap().number),
            );
            assert!(result.updated);
        }
    }
    fn attach_watcher(&self, name: &str, record: &ExecutionRecord) -> Result<(), String> {
        if self.fail {
            return Err("cannot spawn watcher".into());
        }
        self.start_watcher(name, record);
        Ok(())
    }
    fn relaunch(
        &self,
        _backend: &str,
        _command: &str,
        options: &IsolationOptions,
    ) -> IsolationResult {
        assert!(options.defer_completion_watcher);
        IsolationResult {
            success: true,
            container_id: Some("new-id".into()),
            ..Default::default()
        }
    }
    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        record.clone()
    }
}

fn resume(store: &ExecutionStore, record: &ExecutionRecord, command: Option<&str>) {
    let result = resume_execution_with(
        Some(store),
        &record.uuid,
        command,
        Some("json"),
        &support::FakeRunner::new(json!({})),
        &Hooks {
            store,
            immediate: false,
            fail: false,
        },
    );
    assert!(result.success, "{:?}", result.error);
}

#[test]
fn automatic_recovery_after_explicit_resume_keeps_scoped_evidence() {
    let (_temp, store, mut record) = fixture();
    record.options.insert("onKillResume".into(), json!(1));
    store.save(&record).unwrap();
    resume(&store, &record, None);
    let current = store.get(&record.uuid).unwrap();
    let result = start_command::execution_recovery::recover_killed_execution(
        &store,
        &record.uuid,
        &start_command::execution_recovery::RecoveryFacts {
            exit_code: "137".into(),
            oom_killed: "true".into(),
            started_at: current.attempt.as_ref().unwrap().started_at.clone(),
            finished_at: Utc::now().to_rfc3339(),
            cgroup_memory: "128 128 1 1".into(),
            ..Default::default()
        },
        &support::FakeRunner::new(json!({})),
        &|_name, _record, options| {
            assert_eq!(options.attempt_number, Some(3));
            assert_eq!(store.get(&record.uuid).unwrap().attempt.unwrap().number, 3);
        },
    );
    assert!(result.recovered);
    let saved = store.get(&record.uuid).unwrap();
    assert_eq!(saved.attempt_history.len(), 2);
    assert_eq!(saved.attempt_history[1]["exitCode"], 137);
    assert_eq!(saved.attempt_history[1]["cgroupMemory"]["oomKills"], 1);
    assert_eq!(saved.cgroup_memory, None);
    assert_eq!(saved.attempt.as_ref().unwrap().last_output_at, None);
    assert!(saved.attempt.unwrap().log_offset > current.attempt.unwrap().log_offset);
}

#[test]
fn attachment_metadata_preserves_terminal_state_and_rejects_stale_attempts() {
    let (_temp, store, record) = fixture();
    resume(&store, &record, None);
    let mut current = store.get(&record.uuid).unwrap();
    current.status = ExecutionStatus::Executed;
    current.exit_code = Some(0);
    store.save(&current).unwrap();
    let patched = store
        .patch_attempt(
            &record.uuid,
            2,
            json!({"watcherAttachedAt": "2026-10-06T09:00:00Z"}),
        )
        .unwrap()
        .unwrap();
    assert_eq!(patched.status, ExecutionStatus::Executed);
    assert_eq!(patched.exit_code, Some(0));
    assert!(store
        .patch_attempt(&record.uuid, 1, json!({"watcherError": "stale watcher"}))
        .unwrap()
        .is_none());
    assert!(store
        .get(&record.uuid)
        .unwrap()
        .attempt
        .unwrap()
        .watcher_error
        .is_none());
}

#[cfg(unix)]
#[test]
fn real_watcher_shell_captures_output_and_finalizes_the_current_attempt() {
    use start_command::{
        build_detached_docker_completion_script_with, DockerContainerCleanupPolicy,
        DockerWatcherOptions,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    let (temp, store, record) = fixture();
    resume(&store, &record, None);
    let current = store.get(&record.uuid).unwrap();
    let bin = temp.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let docker = bin.join("docker");
    fs::write(
        &docker,
        r#"#!/bin/sh
case "$1" in
  logs) printf '%s command output 🐝\n' "$TEST_OUTPUT_AT" ;;
  wait) echo 0 ;;
  inspect) case "$3" in
    *State.Running*) echo false ;;
    *State.ExitCode*) echo "0 false $TEST_OUTPUT_AT $TEST_OUTPUT_AT" ;;
    *State.Error*) echo '' ;;
    *) exit 1 ;;
  esac ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(docker, fs::Permissions::from_mode(0o755)).unwrap();
    let at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true);
    let attempt = current.attempt.unwrap();
    let script = build_detached_docker_completion_script_with(
        record.options["sessionName"].as_str().unwrap(),
        DockerContainerCleanupPolicy::Keep,
        Some(&record.log_path.clone().into()),
        Some(&record.uuid),
        &DockerWatcherOptions {
            since: Some(attempt.started_at),
            attempt_number: Some(2),
            recover_on_kill: false,
        },
    )
    .replace(
        std::env::current_exe().unwrap().to_string_lossy().as_ref(),
        env!("CARGO_BIN_EXE_start"),
    );
    let mut paths = vec![bin];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let output = Command::new("/bin/sh")
        .args(["-c", &script])
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("TEST_OUTPUT_AT", &at)
        .env("START_APP_FOLDER", temp.path())
        .env("START_COMMAND_CGROUP_ROOT", temp.path().join("no-cgroup"))
        .env("START_COMMAND_PROC_ROOT", temp.path().join("no-proc"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    let saved = store.get(&record.uuid).unwrap();
    assert_eq!(saved.status, ExecutionStatus::Executed);
    assert_eq!(saved.exit_code, Some(0));
    assert_eq!(
        saved.attempt.unwrap().last_output_at.as_deref(),
        Some(at.as_str())
    );
    assert_eq!(saved.cgroup_memory, None);
    assert!(fs::read_to_string(&record.log_path)
        .unwrap()
        .contains("command output 🐝"));
}

#[test]
fn explicit_resume_clears_and_archives_previous_memory_evidence() {
    let mut record = ExecutionRecord::new("worker");
    record.status = ExecutionStatus::Executed;
    record.exit_code = Some(137);
    record.end_time = Some("2026-01-01T00:01:00Z".into());
    record.memory_exhausted = Some(true);
    record.memory_exhausted_reason = Some("cgroup-oom-killer".into());
    record.cgroup_memory = start_command::cgroup_memory::parse_cgroup_memory_sample("128 128 1 1");
    record.options.insert("isolated".into(), json!("docker"));
    record
        .options
        .insert("isolationMode".into(), json!("detached"));
    record.options.insert("sessionName".into(), json!("box"));
    let probe = SessionProbe {
        state: SessionState::Stopped,
        alive: false,
        ..Default::default()
    };
    let plan = build_resume_plan(&record, None, &probe).unwrap();
    apply_resume_to_record(&mut record, &plan, None);
    assert_eq!(record.memory_exhausted, None);
    assert_eq!(record.memory_exhausted_reason, None);
    assert_eq!(record.cgroup_memory, None);
    assert_eq!(record.attempt.as_ref().unwrap().number, 2);
    assert_eq!(record.attempt_history[0]["memoryExhausted"], true);
    assert_eq!(record.attempt_history[0]["cgroupMemory"]["oomKills"], 1);
}

#[test]
fn explicit_resume_archives_all_terminal_fields_and_byte_boundary() {
    let (_temp, store, record) = fixture();
    resume(&store, &record, None);
    let saved = store.get(&record.uuid).unwrap();
    assert_eq!(saved.status, ExecutionStatus::Executing);
    assert_eq!(saved.exit_code, None);
    assert_eq!(saved.end_time_source, None);
    assert_eq!(saved.observed_at, None);
    assert_eq!(saved.stale_detected_at, None);
    assert_eq!(saved.container_started_at, None);
    assert_eq!(saved.memory_exhausted, None);
    assert_eq!(saved.cgroup_memory, None);
    assert!(!saved.options.contains_key("containerError"));
    let attempt = saved.attempt.unwrap();
    assert_eq!(attempt.log_offset, Some(OLD_LOG.len() as u64));
    assert_eq!(attempt.last_output_at, None);
    assert!(attempt.launch_accepted_at.is_some());
    assert!(attempt.watcher_attached_at.is_some());
    assert_eq!(saved.attempt_history[0]["exitCode"], 137);
}

#[test]
fn quiet_status_and_list_do_not_reuse_previous_footer_or_memory_marker() {
    let (_temp, store, record) = fixture();
    resume(&store, &record, None);
    let current = enrich_detached_status(&store.get(&record.uuid).unwrap());
    assert_eq!(current.status, ExecutionStatus::Executing);
    assert_eq!(current.exit_code, None);
    assert_eq!(current.memory_exhausted, None);
    let status: serde_json::Value =
        serde_json::from_str(&format_record(&current, "json").unwrap()).unwrap();
    let list: serde_json::Value =
        serde_json::from_str(&format_record_list(&[current], "json").unwrap()).unwrap();
    assert_eq!(status["attempt"]["logOffset"], OLD_LOG.len());
    assert_eq!(
        list["executions"][0]["attempt"]["startedAt"],
        status["attempt"]["startedAt"]
    );
}

#[test]
fn watcher_immediate_completion_is_never_overwritten() {
    let (_temp, store, record) = fixture();
    let result = resume_execution_with(
        Some(&store),
        &record.uuid,
        None,
        None,
        &support::FakeRunner::new(json!({})),
        &Hooks {
            store: &store,
            immediate: true,
            fail: false,
        },
    );
    assert!(result.success, "{:?}", result.error);
    let current = store.get(&record.uuid).unwrap();
    assert_eq!(current.status, ExecutionStatus::Executed);
    assert_eq!(current.exit_code, Some(0));
}

#[test]
fn failed_launch_preserves_prior_evidence_and_logs_failure() {
    let (_temp, store, record) = fixture();
    let result = resume_execution_with(
        Some(&store),
        &record.uuid,
        None,
        None,
        &support::FakeRunner::new(json!({})).failing("start", "launch rejected"),
        &Hooks {
            store: &store,
            immediate: false,
            fail: false,
        },
    );
    assert!(!result.success);
    let saved = store.get(&record.uuid).unwrap();
    assert_eq!(saved.exit_code, Some(137));
    assert_eq!(saved.memory_exhausted, Some(true));
    let log = fs::read_to_string(&record.log_path).unwrap();
    assert!(log.contains("resume-started"));
    assert!(log.contains("launch-failed"));
    assert!(!log.contains("launch-accepted"));
}

#[test]
fn snapshot_resume_records_both_container_names() {
    let (_temp, store, record) = fixture();
    resume(&store, &record, Some("replacement"));
    let saved = store.get(&record.uuid).unwrap();
    assert!(!start_command::execution_resume::keeps_kill_recovery(
        saved.options["sessionName"].as_str().unwrap(),
        &saved
    ));
    let attempt = saved.attempt.unwrap();
    assert_eq!(
        attempt.previous_session_name.as_deref(),
        record.options["sessionName"].as_str()
    );
    assert!(attempt.session_name.unwrap().ends_with("-resume-1"));
    assert_eq!(saved.attempt_history[0]["command"], "worker");
}

#[test]
fn relaunch_defers_watcher_until_after_persistence() {
    let (_temp, store, record) = fixture();
    let mut runner = support::FakeRunner::new(json!({}));
    runner.container_status = "".into();
    let result = resume_execution_with(
        Some(&store),
        &record.uuid,
        None,
        None,
        &runner,
        &Hooks {
            store: &store,
            immediate: true,
            fail: false,
        },
    );
    assert!(result.success, "{:?}", result.error);
    assert_eq!(
        store.get(&record.uuid).unwrap().attempt.unwrap().mode,
        "relaunch"
    );
}

#[test]
fn failed_watcher_attachment_keeps_accepted_launch_state() {
    let (_temp, store, record) = fixture();
    let result = resume_execution_with(
        Some(&store),
        &record.uuid,
        None,
        None,
        &support::FakeRunner::new(json!({})),
        &Hooks {
            store: &store,
            immediate: false,
            fail: true,
        },
    );
    assert!(!result.success);
    assert!(result.error.unwrap().contains("Launch accepted"));
    let current = store.get(&record.uuid).unwrap();
    assert_eq!(current.status, ExecutionStatus::Executing);
    let attempt = current.attempt.unwrap();
    assert!(attempt.launch_accepted_at.is_some());
    assert!(attempt.watcher_attached_at.is_none());
    assert_eq!(
        attempt.watcher_error.as_deref(),
        Some("cannot spawn watcher")
    );
}

#[test]
fn stale_attempt_finalizer_cannot_replace_current_state() {
    let (_temp, store, record) = fixture();
    resume(&store, &record, None);
    let result = finalize_detached_execution_with_attempt(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "137".into(),
            oom_killed: "true".into(),
            started_at: record.start_time.clone(),
            finished_at: record.end_time.unwrap(),
            ..Default::default()
        },
        Some(1),
    );
    assert_eq!(result.reason, "stale-attempt");
    assert_eq!(store.get(&record.uuid).unwrap().exit_code, None);
}

#[test]
fn fresh_exit_139_cannot_reuse_old_fatal_memory_text() {
    let (_temp, store, record) = fixture();
    resume(&store, &record, None);
    let now = Utc::now().to_rfc3339();
    let result = finalize_detached_execution_with_attempt(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "139".into(),
            oom_killed: "false".into(),
            started_at: now.clone(),
            finished_at: now,
            ..Default::default()
        },
        Some(2),
    );
    assert!(result.updated);
    let current = enrich_detached_status(&store.get(&record.uuid).unwrap());
    assert_eq!(current.memory_exhausted, None);
    assert_eq!(current.cgroup_memory, None);
    assert!(fs::read_to_string(&record.log_path)
        .unwrap()
        .contains("\"event\":\"terminal\""));
}

#[test]
fn output_timestamp_requires_fresh_timestamped_command_output() {
    let (_temp, store, record) = fixture();
    resume(&store, &record, None);
    let current = store.get(&record.uuid).unwrap();
    let attempt = current.attempt.unwrap();
    let mut observer =
        OutputObserver::new(&record.log_path, attempt.number, &attempt.started_at).unwrap();
    observer
        .write(b"Docker administrative error\n2026-01-01T00:00:00Z old output\n")
        .unwrap();
    assert_eq!(
        enrich_detached_status(&store.get(&record.uuid).unwrap())
            .attempt
            .unwrap()
            .last_output_at,
        None
    );
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let output = format!("{} quiet run emits 🐝 without a newline", now);
    observer.write(&output.as_bytes()[..10]).unwrap();
    observer.write(&output.as_bytes()[10..]).unwrap();
    assert_eq!(
        enrich_detached_status(&store.get(&record.uuid).unwrap())
            .attempt
            .unwrap()
            .last_output_at,
        Some(now)
    );
    assert!(fs::read_to_string(&record.log_path)
        .unwrap()
        .contains(&output));
    fs::write(
        activity_path(&record.log_path, attempt.number),
        "2026-01-01T00:00:00Z",
    )
    .unwrap();
    assert_eq!(
        enrich_detached_status(&store.get(&record.uuid).unwrap())
            .attempt
            .unwrap()
            .last_output_at,
        None
    );
}

#[test]
fn byte_reads_are_bounded_and_ignore_prior_evidence_after_truncation() {
    let (_temp, store, record) = fixture();
    resume(&store, &record, None);
    let current = store.get(&record.uuid).unwrap();
    let mut log = fs::read_to_string(&record.log_path).unwrap();
    log.push_str(&format!("\n{}\nfresh\n", "x".repeat(70 * 1024)));
    fs::write(&record.log_path, log).unwrap();
    assert!(read_attempt_log_tail(&current, 64 * 1024).unwrap().len() <= 64 * 1024);
    fs::write(&record.log_path, "old truncated footer").unwrap();
    assert_eq!(
        read_attempt_log_tail(&current, 64 * 1024).as_deref(),
        Some("")
    );
}
