use start_command::cpu_penalty::{accrue, evaluate, initial, observe_base, Config, State};

fn penalized(last_at: i64) -> State {
    let mut state = initial(Some(4.0), 0, None);
    state.phase = "penalized".into();
    state.limit_cpus = Some(2.0);
    state.penalty_count = 1;
    state.penalized_ms = 1000;
    state.last_at = last_at;
    state
}

#[test]
fn accrue_settles_penalized_time_since_last_tick() {
    let mut state = penalized(1000);
    accrue(&mut state, 4000);
    assert_eq!((state.penalized_ms, state.last_at), (4000, 4000));
    let mut early = penalized(5000);
    accrue(&mut early, 4000);
    assert_eq!(early.penalized_ms, 1000);
    let mut observing = penalized(1000);
    observing.phase = "observing".into();
    accrue(&mut observing, 4000);
    assert_eq!(observing.penalized_ms, 1000);
}

#[test]
fn supervisor_override_keeps_penalized_time_before_it() {
    let state = observe_base(&penalized(1000), Some(3.0), 4000);
    assert_eq!(state.phase, "observing");
    assert_eq!(state.penalized_ms, 4000);
    let (next, _) = evaluate(&state, 5000, 0.0, 6.0, 5000, &Config::default());
    assert_eq!(next.penalized_ms, 4000);
}

#[test]
#[cfg(unix)]
fn graceful_stop_lifts_at_once_and_keeps_penalized_ms() {
    use serde_json::json;
    use start_command::{cpu_penalty_monitor, ExecutionRecord};
    for mode in ["graceful", "supervise"] {
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
        // Default 15-minute windows: the monitor ticks every 30 s.
        let config = Config::default();
        record
            .options
            .insert("cpuPenaltyConfig".into(), json!(config));
        let mut command = std::process::Command::new("python3");
        command.args([
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../experiments/issue-218-monitor.py"
            ),
            mode,
            &record.log_path,
        ]);
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
            "{}: {}{}",
            mode,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(std::fs::read_to_string(&record.log_path)
            .unwrap()
            .contains("CPU penalty lifted: 4 CPUs (monitor stopped)"));
    }
}
