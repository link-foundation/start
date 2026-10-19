use serde_json::json;
use start_command::cpu_penalty::{initial, Config};
use start_command::{cpu_penalty_monitor, ExecutionRecord};

#[test]
fn restarted_monitor_preserves_observed_base() {
    let mut saved = initial(Some(4.0), 0, None);
    saved.phase = "penalized".into();
    saved.limit_cpus = Some(2.0);
    assert_eq!(initial(None, 100, Some(saved)).base_cpus, Some(4.0));
}

#[test]
fn saved_observing_limit_preserves_base_after_daemon_clamped_lift() {
    let mut saved = initial(Some(4.0), 0, None);
    saved.limit_cpus = Some(1.0);
    let restarted = initial(None, 100, Some(saved));
    assert_eq!(
        start_command::cpu_penalty::observe_base(&restarted, Some(1.0), 100).base_cpus,
        Some(4.0)
    );
}

#[test]
#[cfg(unix)]
fn monitor_restores_external_limits_and_recovers_dead_owners() {
    for mode in [
        "nano",
        "quota",
        "restart",
        "zombie",
        "reused",
        "supervise",
        "publish-fault",
        // publish-fault with the monitor's republish window forced open (#234).
        "publish-race",
        "graceful",
        "override",
    ] {
        if ["zombie", "reused"].contains(&mode) && !cfg!(target_os = "linux") {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut record = ExecutionRecord::new("CPU monitor");
        record.log_path = dir.path().join("task.log").to_string_lossy().into();
        std::fs::write(&record.log_path, "").unwrap();
        record
            .options
            .insert("sessionName".into(), json!("cpu-task"));
        record.options.insert("isolated".into(), json!("docker"));
        record
            .options
            .insert("baseResourceLimits".into(), json!([]));
        let config = Config {
            trigger_window_ms: 400,
            release_window_ms: 400,
            ..Default::default()
        };
        record
            .options
            .insert("cpuPenaltyConfig".into(), json!(config));
        let mut command = std::process::Command::new("python3");
        command.args([
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../experiments/issue-207-monitor.py"
            ),
            if mode == "publish-race" {
                "publish-fault"
            } else {
                mode
            },
            &record.log_path,
        ]);
        if mode == "publish-race" {
            command.env("START_FIXTURE_UNLINK_DELAY", "1.2");
        }
        if mode == "supervise" {
            let options = start_command::IsolationOptions {
                log_path: Some(record.log_path.clone().into()),
                cpu_penalty_config: Some(config),
                ..Default::default()
            };
            // Snippets use current_exe; substitute the actual CLI for the test executable.
            let script = format!(
                "{}; read done; {}",
                cpu_penalty_monitor::start_snippet_with_options("cpu-task", &options),
                cpu_penalty_monitor::stop_snippet()
            );
            let current = std::env::current_exe().unwrap();
            let script = script.replace(
                &start_command::isolation::isolation_log::shell_quote(&current.to_string_lossy()),
                &start_command::isolation::isolation_log::shell_quote(env!("CARGO_BIN_EXE_start")),
            );
            command.args(["sh", "-c", &script]);
        } else {
            command.args([
                env!("CARGO_BIN_EXE_start"),
                "__start-cpu-monitor",
                "",
                "cpu-task",
                "1",
                &serde_json::to_string(&record).unwrap(),
            ]);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}: {}",
            mode,
            String::from_utf8_lossy(&output.stderr)
        );
        let state = cpu_penalty_monitor::read_state(&record).unwrap();
        let expected = if mode == "override" { 3.0 } else { 4.0 };
        assert_eq!(state["baseCpus"].as_f64(), Some(expected));
        assert_eq!(state["phase"], "observing");
        assert_eq!(state["limitCpus"].as_f64(), Some(expected));
        let mut status_record = record.clone();
        status_record.options.remove("isolated");
        let status_record = start_command::status_formatter::enrich_detached_status(&status_record);
        let status: serde_json::Value = serde_json::from_str(
            &start_command::status_formatter::format_record(&status_record, "json").unwrap(),
        )
        .unwrap();
        assert_eq!(status["cpuPenalty"]["baseCpus"].as_f64(), Some(expected));
        assert_eq!(status["cpuPenalty"]["limitCpus"].as_f64(), Some(expected));
        if mode != "override" {
            assert!(std::fs::read_to_string(&record.log_path)
                .unwrap()
                .contains("CPU penalty lifted: 4"));
        }
    }
}

#[test]
fn stopped_resume_restores_sidecar_base() {
    let dir = tempfile::tempdir().unwrap();
    let mut record = ExecutionRecord::new("work");
    record.log_path = dir.path().join("task.log").to_string_lossy().into();
    record
        .options
        .insert("sessionName".into(), json!("cpu-task"));
    record.options.insert("cpuPenaltyConfig".into(), json!({}));
    record
        .options
        .insert("baseResourceLimits".into(), json!([]));
    std::fs::write(
        cpu_penalty_monitor::state_path(&record),
        json!({"baseCpus":4,"containerName":"cpu-task","attemptNumber":1}).to_string(),
    )
    .unwrap();
    let limits = start_command::resume_resources::restore_base_cpu(
        vec!["--memory=512m".into(), "--cpus=2".into()],
        &record,
    );
    assert_eq!(limits, vec!["--memory=512m", "--cpus=4"]);
}

#[test]
fn stopped_resume_preserves_supervisor_override() {
    use start_command::{CommandRunOutput, CommandRunner, SessionProbe, SessionState};
    struct Runner(f64);
    impl CommandRunner for Runner {
        fn run(&self, _: &str, args: &[String]) -> CommandRunOutput {
            CommandRunOutput {
                success: true,
                stdout: if args[0] == "inspect" {
                    json!({"NanoCpus":self.0*1e9}).to_string()
                } else {
                    json!({"NCPU":6,"MemTotal":1073741824}).to_string()
                },
                ..Default::default()
            }
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut record = ExecutionRecord::new("work");
    record.log_path = dir.path().join("task.log").to_string_lossy().into();
    record.options.insert("isolated".into(), json!("docker"));
    record
        .options
        .insert("sessionName".into(), json!("cpu-task"));
    record.options.insert("cpuPenaltyConfig".into(), json!({}));
    std::fs::write(cpu_penalty_monitor::state_path(&record), json!({"phase":"penalized","limitCpus":2,"baseCpus":4,"containerName":"cpu-task","attemptNumber":1}).to_string()).unwrap();
    for (observed, expected) in [(2.0, 4.0), (3.0, 3.0)] {
        let (limits, _, _) = start_command::resume_resources::prepare(
            &record,
            &SessionProbe {
                state: SessionState::Stopped,
                ..Default::default()
            },
            &json!({}),
            &Runner(observed),
        )
        .unwrap();
        assert_eq!(
            start_command::docker_resource_limits::cpu_count(&limits.unwrap()),
            Some(expected)
        );
    }
}

#[test]
#[cfg(target_os = "linux")]
fn birth_identity_reclaims_reused_pid_but_protects_live_lock() {
    use start_command::store_lock::LockManager;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("lock");
    let mut owner = LockManager::new(file.clone());
    let mut replacement = LockManager::new(file.clone());
    assert!(owner.acquire(100));
    let mut data: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert!(data["processStart"].as_str().is_some());
    assert!(!replacement.acquire(100));
    data["processStart"] = json!("different-birth");
    std::fs::write(&file, data.to_string()).unwrap();
    assert!(replacement.acquire(100));
    owner.release();
    assert!(file.exists());
    replacement.release();
}

#[test]
fn transition_logs_name_window_and_phase_capacity() {
    use start_command::cpu_penalty::{transition_log, Action};
    let config = Config {
        trigger_window_ms: 900000,
        release_window_ms: 400,
        ..Default::default()
    };
    let applied = Action {
        kind: "apply",
        cpus: 2.0,
        capacity: 4.0,
        average: Some(100.0),
    };
    assert!(transition_log(&applied, &config).contains("of 4 CPUs for 15m"));
    let lifted = Action {
        kind: "lift",
        cpus: 4.0,
        ..applied
    };
    assert!(transition_log(&lifted, &config).contains("of 2 CPUs for 400ms"));
}
