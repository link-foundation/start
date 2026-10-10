use start_command::isolation_metadata::build_isolation_options_map;
use start_command::parse_args;

#[test]
fn replacement_container_labels_keep_root_and_uuid() {
    let options = start_command::isolation::IsolationOptions {
        uuid: Some("uuid".to_string()),
        resume_count: 2,
        ..Default::default()
    };
    let labels = start_command::isolation_metadata::docker_attribution_labels(
        &options,
        "demo-resume-1-resume-2",
    );
    assert!(labels.contains(&"start-command.root-session=demo".to_string()));
    assert!(labels.contains(&"start-command.uuid=uuid".to_string()));
    assert!(labels.contains(&"start-command.resume-count=2".to_string()));
}

#[test]
fn docker_labels_are_parsed_and_persisted() {
    let args = [
        "-i",
        "docker",
        "--label",
        "task=codex",
        "--label=url=x?a=b",
        "--label",
        "empty=",
        "--",
        "true",
    ];
    let parsed = parse_args(&args.map(String::from)).unwrap();
    assert_eq!(
        parsed.wrapper_options.labels,
        vec!["task=codex", "url=x?a=b", "empty="]
    );
    let metadata = build_isolation_options_map(
        Some("docker"),
        "detached",
        "task",
        Some("alpine"),
        &parsed.wrapper_options,
        None,
    );
    assert_eq!(
        metadata["labels"],
        serde_json::json!(["task=codex", "url=x?a=b", "empty="])
    );
}

#[test]
fn invalid_or_reserved_labels_are_rejected() {
    for label in ["missing", "=empty", "start-command.uuid=spoof"] {
        assert!(
            parse_args(&["-i", "docker", "--label", label, "--", "true"].map(String::from))
                .is_err()
        );
    }
    assert!(parse_args(&["--label", "task=x", "--", "true"].map(String::from)).is_err());
}
