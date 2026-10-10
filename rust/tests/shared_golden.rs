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
            "memory": options.memory, "cpus": options.cpus});
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
            ..Default::default()
        };
        let observed: Vec<String> = build_docker_runtime_args(&options)
            .into_iter()
            .map(str::to_string)
            .collect();
        assert_eq!(observed, strings(&fixture["argv"]), "{}", fixture["name"]);
    }
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
fn executes_generated_rust_parity_policy() {
    for fixture in fixtures()["parity-threshold"].as_array().unwrap() {
        assert_eq!(
            parity_threshold::minimum_rust_test_count(fixture["javascript"].as_f64().unwrap()),
            fixture["minimumRust"].as_f64().unwrap()
        );
    }
}
