use start_command::parse_args;
#[test]
fn cpu_penalty_settings_are_opt_in_and_parse_durations() {
    let args = [
        "--isolated",
        "docker",
        "--cpu-penalty",
        "--cpu-penalty-trigger-window",
        "1s",
        "--",
        "true",
    ]
    .map(String::from);
    assert!(parse_args(&args).is_ok());
}
use start_command::cpu_penalty::{average, evaluate, initial, Config, Sample};
#[test]
fn complete_windows_and_fresh_observation_after_lift() {
    let config = Config {
        trigger_window_ms: 100,
        release_window_ms: 100,
        ..Default::default()
    };
    let mut state = initial(None, 0, None);
    for (now, cores, expected) in [
        (0, 6.0, None),
        (40, 6.0, None),
        (80, 6.0, None),
        (100, 0.4, Some("apply")),
        (120, 0.4, None),
        (160, 0.4, None),
        (200, 0.4, None),
        (220, 6.0, Some("lift")),
        (240, 6.0, None),
        (280, 6.0, None),
        (320, 6.0, None),
        (340, 6.0, Some("apply")),
    ] {
        let (next, action) = evaluate(&state, now, cores, 6.0, 50, &config);
        state = next;
        assert_eq!(action.map(|a| a.kind), expected);
    }
    assert_eq!(state.penalty_count, 2);
    assert_eq!(state.penalized_ms, 120);
    assert_eq!(
        average(
            &[
                Sample { at: 0, cores: 6.0 },
                Sample { at: 90, cores: 0.0 },
                Sample {
                    at: 100,
                    cores: 0.0
                }
            ],
            100,
            100
        ),
        Some(5.4)
    );
}
#[test]
fn gaps_outages_resize_and_restart_cannot_supply_coverage() {
    let config = Config {
        trigger_window_ms: 100,
        release_window_ms: 100,
        ..Default::default()
    };
    let mut state = initial(None, 0, None);
    for (now, cores, capacity) in [
        (0, 6.0, 6.0),
        (40, 6.0, 6.0),
        (80, f64::NAN, 6.0),
        (120, 6.0, 6.0),
        (160, 6.0, 6.0),
        (200, 8.0, 8.0),
        (400, 8.0, 8.0),
    ] {
        let (next, action) = evaluate(&state, now, cores, capacity, 50, &config);
        state = next;
        assert!(action.is_none());
    }
    let fresh = initial(None, 450, Some(state));
    assert!(evaluate(&fresh, 450, 8.0, 8.0, 50, &config).1.is_none());
}
#[test]
fn resumed_cpu_base_is_bounded_by_resized_daemon() {
    use start_command::{
        CommandRunOutput, CommandRunner, ExecutionRecord, SessionProbe, SessionState,
    };
    struct Runner;
    impl CommandRunner for Runner {
        fn run(&self, _: &str, args: &[String]) -> CommandRunOutput {
            CommandRunOutput {
                success: true,
                stdout: if args[0] == "info" {
                    r#"{"MemTotal":1073741824,"NCPU":2}"#.into()
                } else {
                    r#"{"NanoCpus":500000000}"#.into()
                },
                ..Default::default()
            }
        }
    }
    let mut record = ExecutionRecord::new("work");
    for (k,v) in serde_json::json!({"isolated":"docker","sessionName":"task","cpuPenaltyConfig":{},"baseResourceLimits":["--cpus=3"],"resourceLimits":["--cpus=0.5"],"resolvedLimits":{"cpus":3}}).as_object().unwrap() {record.options.insert(k.clone(),v.clone());}
    let (limits, resolved, _) = start_command::resume_resources::prepare(
        &record,
        &SessionProbe {
            state: SessionState::Stopped,
            ..Default::default()
        },
        &serde_json::json!({}),
        &Runner,
    )
    .unwrap();
    assert!(limits.unwrap().contains(&"--cpus=2".into()));
    assert_eq!(resolved.unwrap()["cpus"].as_f64(), Some(2.0));
    assert_eq!(
        record.options["baseResourceLimits"],
        serde_json::json!(["--cpus=3"])
    );
}

#[test]
#[cfg(unix)]
fn monitor_applies_lifts_and_reapplies_without_tracking() {
    let dir = tempfile::tempdir().unwrap();
    let mut record = start_command::ExecutionRecord::new("CPU monitor");
    record.log_path = dir.path().join("task.log").to_string_lossy().into();
    std::fs::write(&record.log_path, "").unwrap();
    record
        .options
        .insert("sessionName".into(), serde_json::json!("cpu-task"));
    record.options.insert(
        "cpuPenaltyConfig".into(),
        serde_json::json!(Config {
            trigger_window_ms: 200,
            release_window_ms: 200,
            ..Default::default()
        }),
    );
    record
        .options
        .insert("baseResourceLimits".into(), serde_json::json!([]));
    let result = std::process::Command::new("/bin/sh")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../experiments/issue-195-cpu-monitor.sh"
        ))
        .args([
            env!("CARGO_BIN_EXE_start"),
            "__start-cpu-monitor",
            "",
            "cpu-task",
            "1",
            &serde_json::to_string(&record).unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let log = std::fs::read_to_string(&record.log_path).unwrap();
    let lines = log.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("CPU penalty applied: 2"));
    assert!(lines[1].contains("CPU penalty lifted: 6"));
    assert!(lines[2].contains("CPU penalty applied: 2"));
    let state: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(start_command::cpu_penalty_monitor::state_path(&record)).unwrap(),
    )
    .unwrap();
    assert_eq!(state["penaltyCount"], 2);
    assert_eq!(state["phase"], "penalized");
    assert!(state["penalizedMs"].as_i64().unwrap() > 200);
}

#[test]
fn legacy_cpu_base_is_preserved_without_nano_cpu_conversion() {
    use start_command::{
        CommandRunOutput, CommandRunner, ExecutionRecord, SessionProbe, SessionState,
    };
    struct Runner;
    impl CommandRunner for Runner {
        fn run(&self, _: &str, _: &[String]) -> CommandRunOutput {
            CommandRunOutput {
                success: true,
                stdout: r#"{"NCPU":4,"MemTotal":1073741824}"#.into(),
                ..Default::default()
            }
        }
    }
    let mut record = ExecutionRecord::new("work");
    for (k,v) in serde_json::json!({"isolated":"docker","sessionName":"task","cpuPenaltyConfig":{},"baseResourceLimits":["--cpu-period=200000","--cpu-quota=100000"]}).as_object().unwrap() {record.options.insert(k.clone(),v.clone());}
    let (limits, resolved, _) = start_command::resume_resources::prepare(
        &record,
        &SessionProbe {
            state: SessionState::Stopped,
            ..Default::default()
        },
        &serde_json::json!({}),
        &Runner,
    )
    .unwrap();
    assert_eq!(
        limits.unwrap(),
        vec!["--cpu-period=100000", "--cpu-quota=50000"]
    );
    assert_eq!(resolved.unwrap()["cpus"].as_f64(), Some(0.5));
    let (overridden, _, _) = start_command::resume_resources::prepare(
        &record,
        &SessionProbe {
            state: SessionState::Stopped,
            ..Default::default()
        },
        &serde_json::json!({"cpus":"0.25"}),
        &Runner,
    )
    .unwrap();
    assert_eq!(
        overridden.unwrap(),
        vec!["--cpu-period=100000", "--cpu-quota=25000"]
    );
}
