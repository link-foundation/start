//! Regression tests for issue #176:
//!
//!   1. `$ --resume <id> -- <cmd>` snapshots the stopped container with
//!      `docker commit` and starts a new one with `docker run`. `docker commit`
//!      does not keep the HostConfig, so the memory / CPU / PIDs limits the old
//!      container had (often applied later with `docker update`) were silently
//!      dropped. They must be read with `docker inspect` and re-applied.
//!   2. `--on-kill-resume N --recovery-command B` resumes a detached docker
//!      session whose main process was killed (exit 137 / OOMKilled) in the same
//!      container, under the same execution UUID and log, up to N times.

use serde_json::{json, Value};
use start_command::docker_recovery_options::validate_docker_recovery_options;
use start_command::docker_resource_limits::{
    build_resource_limits_status_line, format_docker_bytes, format_docker_cpus,
    normalize_resource_limits, parse_docker_resource_limits, read_docker_resource_limits,
};
use start_command::execution_resume::{
    build_launch_options, build_resume_plan_with_limits, keeps_kill_recovery,
};
use start_command::isolation_metadata::{recovery_metadata, recovery_status_lines};
use start_command::{
    parse_args, resume_execution_with, ExecutionRecord, ExecutionStatus, IsolationOptions,
    IsolationResult, ResumeHooks, ResumeMode, SessionProbe, SessionState,
};
use std::cell::RefCell;
use tempfile::TempDir;
#[path = "support/issue_176.rs"]
mod support;
use support::*;

// ---------------------------------------------------------------------------
// Gap 1: resource limits read from docker inspect
// ---------------------------------------------------------------------------

#[test]
fn formats_sizes_and_cpus_the_way_docker_run_accepts_them() {
    assert_eq!(format_docker_bytes(268435456), "256m");
    assert_eq!(format_docker_bytes(2 * 1024 * 1024 * 1024), "2g");
    assert_eq!(format_docker_bytes(1536 * 1024), "1536k");
    assert_eq!(format_docker_bytes(1000), "1000");
    assert_eq!(format_docker_cpus(500000000), "0.5");
    assert_eq!(format_docker_cpus(1500000000), "1.5");
    assert_eq!(format_docker_cpus(2000000000), "2");
}

#[test]
fn translates_the_host_config_from_the_issue_into_run_flags() {
    assert_eq!(
        parse_docker_resource_limits(&updated_host_config()),
        issue_limits()
    );
}

#[test]
fn emits_nothing_for_an_unlimited_container() {
    let unlimited = json!({
        "Memory": 0, "MemorySwap": 0, "NanoCpus": 0, "PidsLimit": null, "ShmSize": 67108864_i64
    });
    assert!(parse_docker_resource_limits(&unlimited).is_empty());
    assert!(parse_docker_resource_limits(&Value::Null).is_empty());
}

#[test]
fn covers_quota_period_cpusets_shm_storage_options_and_ulimits() {
    let mib = 1024 * 1024_i64;
    let host_config = json!({
        "Memory": 512 * mib,
        "MemorySwap": -1,
        "MemoryReservation": 128 * mib,
        "CpuQuota": 50000,
        "CpuPeriod": 100000,
        "CpuShares": 512,
        "CpusetCpus": "0,1",
        "CpusetMems": "0",
        "PidsLimit": -1,
        "ShmSize": 256 * mib,
        "StorageOpt": { "size": "10G" },
        "Ulimits": [{ "Name": "nofile", "Soft": 1024, "Hard": 2048 }],
    });
    assert_eq!(
        parse_docker_resource_limits(&host_config),
        vec![
            "--memory=512m",
            "--memory-swap=-1",
            "--memory-reservation=128m",
            "--cpu-quota=50000",
            "--cpu-period=100000",
            "--cpu-shares=512",
            "--cpuset-cpus=0,1",
            "--cpuset-mems=0",
            "--shm-size=256m",
            "--storage-opt=size=10G",
            "--ulimit=nofile=1024:2048",
        ]
    );
}

#[test]
fn never_emits_memory_swap_without_memory() {
    assert!(parse_docker_resource_limits(&json!({ "MemorySwap": 268435456_i64 })).is_empty());
}

#[test]
fn reads_the_host_config_with_docker_inspect() {
    let runner = FakeRunner::new(updated_host_config());
    assert_eq!(
        read_docker_resource_limits("box", &runner),
        Some(issue_limits())
    );
    assert_eq!(
        runner.calls()[0][1..],
        ["inspect", "--format", "{{json .HostConfig}}", "box"]
    );
    let gone = FakeRunner::new(json!({})).failing("inspect", "gone");
    assert_eq!(read_docker_resource_limits("box", &gone), None);
}

#[test]
fn keeps_stored_limits_as_flags_including_commas_in_cpusets() {
    assert_eq!(
        normalize_resource_limits(Some(&json!("--cpuset-cpus=0,1 --memory=1g"))),
        vec!["--cpuset-cpus=0,1", "--memory=1g"]
    );
    assert_eq!(
        normalize_resource_limits(Some(&json!(["--cpus=2", "junk"]))),
        vec!["--cpus=2"]
    );
    assert!(normalize_resource_limits(None).is_empty());
    assert_eq!(
        build_resource_limits_status_line(&issue_limits()).as_deref(),
        Some("[Isolation] Resource limits: --memory=256m --memory-swap=256m --cpus=0.5 --pids-limit=64")
    );
    assert_eq!(build_resource_limits_status_line(&[]), None);
}

// ---------------------------------------------------------------------------
// Gap 1: snapshot resume keeps the resource limits
// ---------------------------------------------------------------------------

#[test]
fn passes_the_live_limits_to_docker_run_of_the_resume_n_container() {
    let record = docker_record(ExecutionStatus::Executed, None, json!({}));
    let plan = build_resume_plan_with_limits(
        &record,
        Some("npm run build"),
        &stopped_probe(),
        Some(issue_limits()),
    )
    .unwrap();
    assert_eq!(plan.mode, ResumeMode::DockerSnapshot);
    assert_eq!(plan.resource_limits, issue_limits());
    let run_args = &plan.steps[1].args;
    let image_index = run_args
        .iter()
        .position(|arg| arg == "start-command-resume/box:1")
        .expect("snapshot image in docker run");
    assert_eq!(
        run_args[image_index - ISSUE_LIMITS.len()..image_index],
        ISSUE_LIMITS
    );
}

#[test]
fn falls_back_to_the_limits_stored_in_the_record() {
    let record = docker_record(
        ExecutionStatus::Executed,
        None,
        json!({ "resourceLimits": ["--memory=1g"] }),
    );
    let plan =
        build_resume_plan_with_limits(&record, Some("npm run build"), &stopped_probe(), None)
            .unwrap();
    assert!(plan.steps[1].args.contains(&"--memory=1g".to_string()));
}

#[test]
fn carries_stored_limits_into_a_relaunch() {
    let record = docker_record(
        ExecutionStatus::Executed,
        None,
        json!({ "resourceLimits": ["--pids-limit=64"] }),
    );
    let probe = SessionProbe {
        backend: Some("docker".to_string()),
        state: SessionState::Missing,
        alive: false,
        ..SessionProbe::default()
    };
    let plan = build_resume_plan_with_limits(&record, None, &probe, None).unwrap();
    assert_eq!(plan.mode, ResumeMode::Relaunch);
    assert_eq!(
        plan.launch_options.unwrap().resource_limits,
        vec!["--pids-limit=64"]
    );
    assert_eq!(
        build_launch_options(&record).resource_limits,
        vec!["--pids-limit=64"]
    );
}

#[derive(Default)]
struct RecordingHooks {
    watchers: RefCell<Vec<(String, bool)>>,
}

impl ResumeHooks for RecordingHooks {
    fn start_watcher(&self, session_name: &str, record: &ExecutionRecord) {
        self.watchers.borrow_mut().push((
            session_name.to_string(),
            keeps_kill_recovery(session_name, record),
        ));
    }

    fn relaunch(
        &self,
        _backend: &str,
        _command: &str,
        _options: &IsolationOptions,
    ) -> IsolationResult {
        panic!("a stopped container must not be relaunched");
    }

    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        record.clone()
    }
}

#[test]
fn inspects_the_old_container_before_the_commit_and_records_the_limits() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let log_path = temp.path().join("run.log");
    std::fs::write(&log_path, "first run\n").unwrap();
    let record = docker_record(
        ExecutionStatus::Executed,
        Some(&log_path),
        json!({ "onKillResume": 2, "stopRequestedAt": "2026-10-01T10:04:00Z" }),
    );
    store.save(&record).unwrap();
    let runner = FakeRunner::new(updated_host_config());
    let hooks = RecordingHooks::default();

    let result = resume_execution_with(
        Some(&store),
        &record.uuid,
        Some("npm run build"),
        Some("json"),
        &runner,
        &hooks,
    );
    assert!(result.success, "{:?}", result.error);

    let verbs = runner.verbs();
    let inspect = verbs
        .iter()
        .rposition(|verb| verb == "inspect")
        .expect("docker inspect");
    let commit = verbs.iter().position(|verb| verb == "commit").unwrap();
    assert!(inspect < commit, "{:?}", verbs);
    let run = runner.call("run").unwrap();
    for flag in ISSUE_LIMITS {
        assert!(
            run.contains(&flag.to_string()),
            "{} missing in {:?}",
            flag,
            run
        );
    }

    let updated = store.get(&record.uuid).unwrap();
    assert_eq!(updated.options["resourceLimits"], json!(ISSUE_LIMITS));
    assert_eq!(updated.options["sessionName"], json!("box-resume-1"));
    assert!(!updated.options.contains_key("stopRequestedAt"));
    let output = result.output.unwrap();
    assert!(output.contains("--pids-limit=64"), "{}", output);
    let log = std::fs::read_to_string(&log_path).unwrap();
    assert!(log.contains(
        "[Isolation] Resource limits: --memory=256m --memory-swap=256m --cpus=0.5 --pids-limit=64"
    ));
    // A snapshot container has no recovery selector.
    assert_eq!(
        *hooks.watchers.borrow(),
        vec![("box-resume-1".to_string(), false)]
    );
}

#[test]
fn a_docker_start_resume_keeps_the_kill_recovery() {
    let record = docker_record(
        ExecutionStatus::Executed,
        None,
        json!({ "onKillResume": 2 }),
    );
    assert!(keeps_kill_recovery("box", &record));
    assert!(!keeps_kill_recovery("box-resume-1", &record));
    let plain = docker_record(ExecutionStatus::Executed, None, json!({}));
    assert!(!keeps_kill_recovery("box", &plain));
}

// ---------------------------------------------------------------------------
// Gap 2: --on-kill-resume / --recovery-command options
// ---------------------------------------------------------------------------

fn launch(flags: &[&str]) -> Result<start_command::ParsedArgs, String> {
    let mut all = vec!["--isolated", "docker", "--detached"];
    all.extend_from_slice(flags);
    all.extend_from_slice(&["--", "solve"]);
    parse_args(&args(&all))
}

#[test]
fn parses_both_options_in_separate_and_equals_forms() {
    let options = launch(&[
        "--on-kill-resume",
        "3",
        "--recovery-command",
        "solve --resume",
    ])
    .unwrap()
    .wrapper_options;
    assert_eq!(options.on_kill_resume, Some(3));
    assert_eq!(options.recovery_command.as_deref(), Some("solve --resume"));
    let eq = launch(&["--on-kill-resume=2", "--recovery-command=b"])
        .unwrap()
        .wrapper_options;
    assert_eq!(eq.on_kill_resume, Some(2));
    assert_eq!(eq.recovery_command.as_deref(), Some("b"));
}

#[test]
fn defaults_to_one_attempt_when_only_a_recovery_command_is_given() {
    let options = launch(&["--recovery-command", "b"])
        .unwrap()
        .wrapper_options;
    assert_eq!(options.on_kill_resume, Some(1));
}

#[test]
fn rejects_invalid_counts_and_missing_values() {
    let error = |flags: &[&str]| launch(flags).err().unwrap_or_default();
    assert!(error(&["--on-kill-resume", "0"]).contains("positive integer"));
    assert!(error(&["--on-kill-resume=x"]).contains("positive integer"));
    assert!(error(&["--on-kill-resume=+3"]).contains("positive integer"));
    assert!(error(&["--recovery-command"]).contains("requires a command"));
    assert!(error(&["--recovery-command="]).contains("non-empty"));
}

#[test]
fn requires_a_detached_docker_only_session() {
    let error = |values: &[&str]| parse_args(&args(values)).err().unwrap_or_default();
    assert!(
        error(&["--isolated", "docker", "--on-kill-resume", "2", "--", "a"])
            .contains("requires --detached")
    );
    assert!(error(&[
        "--isolated",
        "screen",
        "--detached",
        "--on-kill-resume",
        "2",
        "--",
        "a"
    ])
    .contains("only valid with --isolated docker"));
    assert!(
        error(&["--on-kill-resume", "2", "--", "a"]).contains("only valid with --isolated docker")
    );
    // Validation is idempotent on an already valid set of options.
    let mut options = launch(&["--on-kill-resume", "2"]).unwrap().wrapper_options;
    assert!(validate_docker_recovery_options(&mut options).is_ok());
}

#[test]
fn describes_the_recovery_in_isolation_lines_and_metadata() {
    assert_eq!(
        recovery_status_lines(Some(3), Some("solve --resume")),
        vec!["[Isolation] On kill: resume up to 3 time(s) with solve --resume"]
    );
    assert_eq!(
        recovery_status_lines(Some(1), None),
        vec!["[Isolation] On kill: resume up to 1 time(s) with the original command"]
    );
    assert!(recovery_status_lines(None, None).is_empty());
    assert_eq!(
        recovery_metadata(Some(3), Some("solve --resume")),
        vec![
            ("onKillResume".to_string(), json!(3)),
            ("recoveryCommand".to_string(), json!("solve --resume")),
        ]
    );

    let options = launch(&[
        "--on-kill-resume",
        "3",
        "--recovery-command",
        "solve --resume",
    ])
    .unwrap()
    .wrapper_options;
    assert!(
        start_command::docker_runtime_status_lines_for_options(&options).contains(
            &"[Isolation] On kill: resume up to 3 time(s) with solve --resume".to_string()
        )
    );
    let map = start_command::build_isolation_options_map(
        Some("docker"),
        "detached",
        "box",
        Some("ubuntu:24.04"),
        &options,
        None,
    );
    assert_eq!(map["onKillResume"], json!(3));
    assert_eq!(map["recoveryCommand"], json!("solve --resume"));
}
