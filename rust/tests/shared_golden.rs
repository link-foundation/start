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
        if fixture.get("dockerResourceLimits").is_some() {
            let (limits, _) = start_command::docker_resource_options::resolve(
                &start_command::docker_resource_options::specs(&options),
                &[],
                &start_command::execution_control::SystemCommandRunner,
                || 0.5,
            )
            .unwrap();
            let mut actual = build_docker_runtime_args(&IsolationOptions {
                resource_limits: limits,
                ..Default::default()
            });
            let mut expected = strings(&fixture["dockerResourceLimits"]);
            actual.sort();
            expected.sort();
            assert_eq!(actual, expected);
        }
        let observed = json!({"isolated": options.isolated, "detached": options.detached,
            "session": options.session, "status": options.status, "outputFormat": options.output_format,
            "memory": options.memory, "memoryReservation": options.memory_reservation, "cpus": options.cpus, "resume": options.resume,
            "snapshotWait": seconds(options.snapshot.wait),
            "snapshotDiskWait": seconds(options.snapshot.disk_wait),
            "removeOriginalAfter": seconds(options.snapshot.remove_original_after),
            "snapshotSizeHint": options.snapshot.size_hint, "snapshotPrepare": options.snapshot.prepare,
            "removeOriginal": options.remove_original, "cleanup": options.cleanup,
            "cleanupDryRun": options.cleanup_dry_run, "cleanupTarget": options.cleanup_target,
            "init": options.init, "useFormalAi": options.use_formal_ai,
            "stop": options.stop, "stopTimeout": options.stop_timeout});
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
            init: input["init"].as_bool().unwrap_or(false),
            stop_timeout: input["stopTimeout"].as_u64(),
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

/// In-memory docker of the `pause-control` contracts (issue #263); the rules
/// are spelled out in `pause-control.docker` and mirrored by
/// `goldenDocker` in js/test/fixtures/pause-golden.cjs.
struct GoldenDocker {
    name: String,
    state: std::cell::RefCell<String>,
    calls: std::cell::RefCell<Vec<(Vec<String>, bool)>>,
}

impl GoldenDocker {
    fn answer(&self, args: &[String]) -> start_command::CommandRunOutput {
        let ok = |stdout: String| start_command::CommandRunOutput {
            success: true,
            stdout,
            status: Some(0),
            ..Default::default()
        };
        let fail = |stderr: String| start_command::CommandRunOutput {
            success: false,
            stderr,
            status: Some(1),
            ..Default::default()
        };
        let name = &self.name;
        let state = self.state.borrow().clone();
        let verb = args.first().map(String::as_str).unwrap_or_default();
        if state == "removed" && verb != "rm" {
            return fail(format!(
                "Error response from daemon: No such container: {name}"
            ));
        }
        let alive = state == "running" || state == "paused";
        let next = match verb {
            "inspect" => {
                let format = args
                    .iter()
                    .position(|arg| arg == "-f")
                    .and_then(|i| args.get(i + 1))
                    .map(String::as_str)
                    .unwrap_or_default();
                return ok(match format {
                    "{{.State.Status}} {{.State.Paused}}" => {
                        format!("{state} {}\n", state == "paused")
                    }
                    "{{.State.Status}}" => format!("{state}\n"),
                    "{{.Id}} {{.State.Pid}}" => {
                        format!("abc263def {}\n", if alive { 4242 } else { 0 })
                    }
                    _ => String::new(),
                });
            }
            "pause" if state != "running" => {
                return fail(format!("container {name} is not running"));
            }
            "unpause" if state != "paused" => {
                return fail(format!("container {name} is not paused"));
            }
            "pause" => "paused",
            "unpause" => "running",
            _ => return ok(String::new()),
        };
        *self.state.borrow_mut() = next.to_string();
        ok(format!("{name}\n"))
    }
}

impl start_command::CommandRunner for GoldenDocker {
    fn run(&self, _command: &str, args: &[String]) -> start_command::CommandRunOutput {
        self.calls.borrow_mut().push((args.to_vec(), false));
        self.answer(args)
    }

    fn run_with_timeout(
        &self,
        _command: &str,
        args: &[String],
        _timeout: std::time::Duration,
    ) -> start_command::CommandRunOutput {
        self.calls.borrow_mut().push((args.to_vec(), true));
        self.answer(args)
    }
}

/// Replace every ISO-8601 timestamp, which differs per run, with a marker.
fn normalize_timestamps(value: Value) -> Value {
    let timestamp =
        regex::Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")
            .unwrap();
    match value {
        Value::String(text) => Value::String(timestamp.replace_all(&text, "<timestamp>").into()),
        Value::Array(items) => Value::Array(items.into_iter().map(normalize_timestamps).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, entry)| (key, normalize_timestamps(entry)))
                .collect(),
        ),
        other => other,
    }
}

#[test]
fn pause_control_matches_shared_goldens() {
    use start_command::execution_pause::{
        pause_execution_with_runner, unpause_execution_with_runner, PauseRequest,
    };
    use start_command::{ExecutionStore, ExecutionStoreOptions};
    let fixtures = fixtures();
    let section = &fixtures["pause-control"];
    let base = &section["record"];
    let uuid = base["uuid"].as_str().unwrap();
    for fixture in section["cases"].as_array().unwrap() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(dir.path().to_path_buf()),
            use_links: Some(false),
            verbose: false,
        });
        let mut record = base.clone();
        for key in ["status", "exitCode"] {
            if let Some(value) = fixture.get(key) {
                record[key] = value.clone();
            }
        }
        if let Some(extra) = fixture["options"].as_object() {
            for (key, value) in extra {
                record["options"][key] = value.clone();
            }
        }
        store
            .save(&ExecutionRecord::from_json(&record).unwrap())
            .unwrap();
        let docker = GoldenDocker {
            name: base["options"]["sessionName"].as_str().unwrap().to_string(),
            state: std::cell::RefCell::new(fixture["docker"].as_str().unwrap().to_string()),
            calls: Default::default(),
        };
        let identifier = fixture["identifier"].as_str().unwrap();
        let output_format = fixture["outputFormat"].as_str();
        let result = if fixture["action"] == "pause" {
            let request = PauseRequest {
                reason: fixture["reason"].as_str(),
                by: fixture["by"].as_str(),
                output_format,
            };
            pause_execution_with_runner(Some(&store), identifier, request, &docker)
        } else {
            unpause_execution_with_runner(Some(&store), identifier, output_format, &docker)
        };
        let output = match (result.output, output_format) {
            (Some(text), Some("json")) => serde_json::from_str(&text).unwrap(),
            (Some(text), _) => json!(text),
            (None, _) => Value::Null,
        };
        let saved = store.get(uuid).unwrap().to_json();
        let calls = docker.calls.borrow();
        let observed = normalize_timestamps(json!({
            "success": result.success,
            "output": output,
            "error": result.error,
            "dockerCalls": calls.iter().map(|(args, _)| args.clone()).collect::<Vec<_>>(),
            "unboundedDockerCalls": calls
                .iter()
                .filter(|(_, bounded)| !bounded)
                .map(|(args, _)| args.clone())
                .collect::<Vec<_>>(),
            "dockerState": docker.state.borrow().clone(),
            "record": {
                "status": saved["status"],
                "exitCode": saved["exitCode"],
                "containerState": saved.get("containerState").cloned().unwrap_or(Value::Null),
                "options": saved["options"],
            },
        }));
        // The case name, not the observed value (which carries the execution
        // UUID), labels a failure: CodeQL's rust/cleartext-logging (#168).
        let name = fixture["name"].as_str().unwrap();
        for key in fixture["expected"].as_object().unwrap().keys() {
            assert!(
                observed[key] == fixture["expected"][key],
                "pause-control case {name:?} differs in {key}"
            );
        }
    }
}
