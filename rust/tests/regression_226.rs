//! Issue #226: `$ --status` printed nested option values (launchOwner,
//! exitEvidence, resolvedLimits, resourceLimitSpecs) as quoted JSON in Rust
//! and as "[object Object]" in JavaScript.
use serde_json::json;
use start_command::status_formatter::{format_record, format_record_list};
use start_command::ExecutionRecord;

fn record_with_nested_options() -> ExecutionRecord {
    ExecutionRecord::from_json(&json!({
        "uuid": "obj-demo-uuid",
        "pid": null,
        "status": "executed",
        "exitCode": 1,
        "command": "sh -c 'exit 1'",
        "logPath": "/tmp/obj-demo.log",
        "startTime": "2026-10-19T00:00:00.000Z",
        "endTime": "2026-10-19T00:00:10.000Z",
        "workingDirectory": "/workspace",
        "shell": "/bin/sh",
        "platform": "linux",
        "options": {
            "isolated": "docker",
            "isolationMode": "detached",
            "sessionName": "obj-demo",
            "launchOwner": {"pid": 522913, "hostname": "70a2c2990824"},
            "exitEvidence": {"daemonRestart": false, "mainOom": false},
            "resolvedLimits": {"cpus": 2, "memory": "4g"},
            "resourceLimitSpecs": {"memory": {"value": "4g", "source": "flag"}},
            "ports": ["8080:80", "9090:90"]
        }
    }))
    .unwrap()
}

fn next_lines(output: &str, line: &str, count: usize) -> Vec<String> {
    let lines: Vec<&str> = output.lines().collect();
    let at = lines.iter().position(|l| *l == line).unwrap();
    lines[at + 1..at + 1 + count]
        .iter()
        .map(|l| l.to_string())
        .collect()
}

#[test]
fn links_notation_renders_nested_option_values() {
    let output = format_record(&record_with_nested_options(), "links-notation").unwrap();
    assert!(!output.contains("[object Object]"));
    assert!(!output.contains("{\""), "no quoted JSON: {output}");
    assert_eq!(
        next_lines(&output, "    launchOwner", 2),
        ["        hostname 70a2c2990824", "        pid 522913"]
    );
    assert_eq!(
        next_lines(&output, "    exitEvidence", 2),
        ["        daemonRestart false", "        mainOom false"]
    );
    assert_eq!(
        next_lines(&output, "    resolvedLimits", 2),
        ["        cpus 2", "        memory 4g"]
    );
    assert_eq!(
        next_lines(&output, "    resourceLimitSpecs", 3),
        [
            "        memory",
            "            source flag",
            "            value 4g"
        ]
    );
    assert_eq!(
        next_lines(&output, "    ports", 4),
        [
            "      (",
            "        \"8080:80\"",
            "        \"9090:90\"",
            "      )"
        ]
    );
}

#[test]
fn text_format_renders_nested_option_values_as_json() {
    let output = format_record(&record_with_nested_options(), "text").unwrap();
    assert!(output.contains("  launchOwner: {\"hostname\":\"70a2c2990824\",\"pid\":522913}"));
    assert!(output.contains("  exitEvidence: {\"daemonRestart\":false,\"mainOom\":false}"));
    assert!(output.contains("  ports: [\"8080:80\",\"9090:90\"]"));
}

#[test]
fn list_output_keeps_nested_values_in_every_format() {
    for format in ["links-notation", "text", "json"] {
        let output = format_record_list(&[record_with_nested_options()], format).unwrap();
        assert!(!output.contains("[object Object]"), "{format}");
        assert!(output.contains("522913"), "{format}");
    }
}
