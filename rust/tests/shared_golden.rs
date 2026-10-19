//! Both native implementations consume the same externally visible contracts.
use serde_json::{json, Value};
use start_command::isolation::build_docker_runtime_args;
use start_command::{format_record, parse_args, ExecutionRecord, IsolationOptions};

#[path = "../src/lib/generated/parity_threshold.rs"]
#[rustfmt::skip]
mod parity_threshold;

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../../parity/fixtures/contracts.json")).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|values| {
            values
                .iter()
                .map(|entry| entry.as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn attempt_status_output_matches_shared_goldens() {
    for fixture in fixtures()["attempt-status-output"].as_array().unwrap() {
        let record = ExecutionRecord::from_json(&fixture["record"]).unwrap();
        let output = start_command::enrich_detached_status(&record);
        let json: Value = serde_json::from_str(&format_record(&output, "json").unwrap()).unwrap();
        assert_eq!(
            json["attemptHistory"], fixture["attemptHistory"],
            "{}",
            fixture["name"]
        );
        assert_eq!(record.to_json(), fixture["record"]);
    }
}

#[test]
fn docker_oom_event_matches_shared_goldens() {
    for fixture in fixtures()["docker-oom-event"].as_array().unwrap() {
        assert_eq!(
            start_command::exit_evidence::recent_docker_oom(
                fixture["events"].as_str().unwrap(),
                fixture["finishedAt"].as_str().unwrap()
            ),
            fixture["recent"].as_bool().unwrap(),
            "{}",
            fixture["name"]
        );
    }
}

/// Seconds as JSON numbers compare in JavaScript: 600, not 600.0.
fn seconds(value: Option<f64>) -> serde_json::Value {
    match value {
        Some(whole) if whole.fract() == 0.0 && whole >= 0.0 => json!(whole as u64),
        other => json!(other),
    }
}

#[test]
fn cli_parsing_matches_shared_goldens() {
    for fixture in fixtures()["cli-parsing"].as_array().unwrap() {
        let parsed = parse_args(&strings(&fixture["argv"]));
        if let Some(error) = fixture["error"].as_str() {
            assert!(parsed.unwrap_err().contains(error), "{}", fixture["name"]);
            continue;
        }
        let parsed = parsed.unwrap();
        assert_eq!(
            parsed.command,
            fixture["command"].as_str().unwrap(),
            "{}",
            fixture["name"]
        );
        assert_eq!(parsed.raw_command, strings(&fixture["rawCommand"]));
        let options = parsed.wrapper_options;
        let observed = json!({"isolated": options.isolated, "detached": options.detached,
            "session": options.session, "status": options.status, "outputFormat": options.output_format,
            "memory": options.memory, "cpus": options.cpus, "resume": options.resume,
            "snapshotWait": seconds(options.snapshot.wait),
            "snapshotDiskWait": seconds(options.snapshot.disk_wait),
            "removeOriginalAfter": seconds(options.snapshot.remove_original_after),
            "snapshotSizeHint": options.snapshot.size_hint, "snapshotPrepare": options.snapshot.prepare,
            "removeOriginal": options.remove_original, "cleanup": options.cleanup,
            "cleanupDryRun": options.cleanup_dry_run, "cleanupTarget": options.cleanup_target});
        for (key, expected) in fixture["options"].as_object().unwrap() {
            assert_eq!(&observed[key], expected, "{}: {}", fixture["name"], key);
        }
    }
}

#[test]
fn isolation_arguments_match_shared_goldens() {
    for fixture in fixtures()["isolation-arguments"].as_array().unwrap() {
        let input = &fixture["options"];
        let options = IsolationOptions {
            privileged: input["privileged"].as_bool().unwrap_or(false),
            env: strings(&input["env"]),
            labels: strings(&input["labels"]),
            volumes: strings(&input["volumes"]),
            mounts: strings(&input["mounts"]),
            networks: strings(&input["networks"]),
            network_aliases: strings(&input["networkAliases"]),
            resource_limits: strings(&input["resourceLimits"]),
            execution_id: input["executionId"].as_str().map(str::to_string),
            attempt_number: input["attemptNumber"].as_u64().unwrap_or(1),
            ..Default::default()
        };
        let observed = build_docker_runtime_args(&options);
        assert_eq!(observed, strings(&fixture["argv"]), "{}", fixture["name"]);
    }
}

#[test]
fn status_identity_matches_shared_goldens() {
    use start_command::execution_chain::{build_chain, identity_text_lines};
    use start_command::execution_identity::execution_aliases;
    let fixture = &fixtures()["status-identity"];
    let records: Vec<ExecutionRecord> = fixture["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| ExecutionRecord::from_json(r).unwrap())
        .collect();
    let record = records.iter().find(|r| r.uuid == fixture["uuid"]).unwrap();
    let aliases = execution_aliases(record);
    let chain: Vec<String> = build_chain(&records, record)
        .into_iter()
        .map(|r| r.uuid)
        .collect();
    assert_eq!(aliases, strings(&fixture["aliases"]));
    assert_eq!(chain, strings(&fixture["chain"]));
    let fields = vec![
        ("aliases".to_string(), json!(aliases)),
        ("chain".to_string(), json!(chain)),
    ];
    assert_eq!(
        identity_text_lines(record, &fields),
        strings(&fixture["text"])
    );
}

#[test]
fn status_output_matches_shared_goldens() {
    let fixture = &fixtures()["status-output"];
    let record = ExecutionRecord::from_json(&fixture["record"]).unwrap();
    let json: Value = serde_json::from_str(&format_record(&record, "json").unwrap()).unwrap();
    assert_eq!(json, fixture["json"]);
    assert_eq!(
        format_record(&record, "text").unwrap(),
        fixture["text"].as_str().unwrap()
    );
}

fn output_block(text: &str, start: &str, is_end: fn(&str) -> bool) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let from = lines.iter().position(|line| *line == start).unwrap();
    let mut block = vec![start.to_string()];
    block.extend(
        lines[from + 1..]
            .iter()
            .take_while(|line| !is_end(line))
            .map(|line| line.to_string()),
    );
    block
}

#[test]
fn status_nested_options_match_shared_goldens() {
    // Issue #226: nested option values are rendered, never "[object Object]".
    let fixture = &fixtures()["status-nested-options"];
    let record = ExecutionRecord::from_json(&fixture["record"]).unwrap();
    let expected = |key: &str| -> Vec<String> {
        fixture[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap().to_string())
            .collect()
    };
    let links = format_record(&record, "links-notation").unwrap();
    let links_end = |line: &str| line.starts_with("  ") && !line.starts_with("   ");
    assert_eq!(
        output_block(&links, "  options", links_end),
        expected("links")
    );
    let text = format_record(&record, "text").unwrap();
    let text_end = |line: &str| !line.starts_with(' ');
    assert_eq!(output_block(&text, "Options:", text_end), expected("text"));
}

#[test]
fn execution_record_format_matches_shared_goldens() {
    for fixture in fixtures()["execution-record-format"].as_array().unwrap() {
        assert_eq!(
            ExecutionRecord::from_json(fixture).unwrap().to_json(),
            *fixture
        );
    }
}

#[test]
fn cpu_penalty_state_matches_shared_goldens() {
    use start_command::cpu_penalty::{evaluate, initial, observe_base, Config, State};
    for fixture in fixtures()["cpu-penalty-state"].as_array().unwrap() {
        let config: Config = serde_json::from_value(fixture["config"].clone()).unwrap();
        let saved = fixture
            .get("saved")
            .map(|v| serde_json::from_value::<State>(v.clone()).unwrap());
        let mut state = initial(fixture["baseCpus"].as_f64(), 0, saved);
        for step in fixture["steps"].as_array().unwrap() {
            let now = step["now"].as_i64().unwrap();
            state = observe_base(&state, step["baseCpus"].as_f64(), now);
            let (next, action) = evaluate(
                &state,
                now,
                step["cores"].as_f64().unwrap(),
                6.0,
                50,
                &config,
            );
            assert_eq!(
                action.map(|a| a.kind),
                step["action"].as_str(),
                "{}",
                fixture["name"]
            );
            state = next;
        }
        let actual = serde_json::to_value(state).unwrap();
        for (key, value) in fixture["expected"].as_object().unwrap() {
            assert_eq!(&actual[key], value, "{}: {}", fixture["name"], key);
        }
    }
}

#[test]
fn executes_generated_rust_parity_policy() {
    for fixture in fixtures()["parity-threshold"].as_array().unwrap() {
        assert_eq!(
            parity_threshold::minimum_rust_test_count(fixture["javascript"].as_f64().unwrap()),
            fixture["minimumRust"].as_f64().unwrap()
        );
    }
}
