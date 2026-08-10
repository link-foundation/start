use super::*;

#[test]
fn test_docker_runtime_status_lines_empty() {
    assert!(docker_runtime_status_lines(&[], &[], &[], false, None, &[], &[]).is_empty());
}

#[test]
fn test_docker_runtime_status_lines_populated() {
    let lines = docker_runtime_status_lines(
        &["/h:/c:ro".to_string()],
        &["type=bind,src=/h,dst=/c".to_string()],
        &["FOO=bar".to_string()],
        true,
        Some("hive-formal-ai"),
        &["hive-formal-ai".to_string(), "public-egress".to_string()],
        &["formal-ai".to_string(), "checker".to_string()],
    );
    assert_eq!(
        lines,
        vec![
            "[Isolation] Volumes: /h:/c:ro".to_string(),
            "[Isolation] Mounts: type=bind,src=/h,dst=/c".to_string(),
            "[Isolation] Env: FOO=bar".to_string(),
            "[Isolation] Privileged: true".to_string(),
            "[Isolation] Network: hive-formal-ai".to_string(),
            "[Isolation] Networks: hive-formal-ai, public-egress".to_string(),
            "[Isolation] Network aliases: formal-ai, checker".to_string(),
        ]
    );
}

#[test]
fn test_docker_runtime_status_lines_joins_multiple() {
    let lines = docker_runtime_status_lines(
        &["/a:/a".to_string(), "/b:/b".to_string()],
        &[],
        &[],
        false,
        None,
        &[],
        &[],
    );
    assert_eq!(lines, vec!["[Isolation] Volumes: /a:/a, /b:/b".to_string()]);
}

#[test]
fn test_docker_runtime_metadata_empty() {
    assert!(docker_runtime_metadata(&[], &[], &[], false, None, &[], &[]).is_empty());
}

#[test]
fn test_docker_runtime_metadata_populated() {
    let entries = docker_runtime_metadata(
        &["/h:/c".to_string()],
        &["type=bind,src=/h,dst=/c".to_string()],
        &["FOO=bar".to_string()],
        true,
        Some("hive-formal-ai"),
        &["hive-formal-ai".to_string(), "public-egress".to_string()],
        &["formal-ai".to_string(), "checker".to_string()],
    );
    let map: std::collections::HashMap<_, _> = entries.into_iter().collect();
    assert_eq!(
        map.get("volumes"),
        Some(&serde_json::json!(["/h:/c".to_string()]))
    );
    assert_eq!(
        map.get("mounts"),
        Some(&serde_json::json!(["type=bind,src=/h,dst=/c".to_string()]))
    );
    assert_eq!(
        map.get("env"),
        Some(&serde_json::json!(["FOO=bar".to_string()]))
    );
    assert_eq!(map.get("privileged"), Some(&serde_json::Value::Bool(true)));
    assert_eq!(
        map.get("network"),
        Some(&serde_json::json!("hive-formal-ai"))
    );
    assert_eq!(
        map.get("networks"),
        Some(&serde_json::json!(["hive-formal-ai", "public-egress"]))
    );
    assert_eq!(
        map.get("networkAliases"),
        Some(&serde_json::json!(["formal-ai", "checker"]))
    );
}

#[test]
fn test_docker_runtime_metadata_omits_privileged_when_false() {
    let entries = docker_runtime_metadata(&["/h:/c".to_string()], &[], &[], false, None, &[], &[]);
    let map: std::collections::HashMap<_, _> = entries.into_iter().collect();
    assert!(map.contains_key("volumes"));
    assert!(!map.contains_key("privileged"));
    assert!(!map.contains_key("mounts"));
    assert!(!map.contains_key("env"));
}

#[test]
fn test_build_isolation_options_map_basic() {
    let opts = WrapperOptions::default();
    let map = build_isolation_options_map(
        Some("docker"),
        "detached",
        "my-session",
        Some("alpine:latest"),
        &opts,
        None,
    );
    assert_eq!(map.get("isolated"), Some(&serde_json::json!("docker")));
    assert_eq!(
        map.get("isolationMode"),
        Some(&serde_json::json!("detached"))
    );
    assert_eq!(
        map.get("sessionName"),
        Some(&serde_json::json!("my-session"))
    );
    assert_eq!(map.get("image"), Some(&serde_json::json!("alpine:latest")));
    assert_eq!(map.get("keepAlive"), Some(&serde_json::Value::Bool(false)));
    assert!(!map.contains_key("volumes"));
}

#[test]
fn test_build_isolation_options_map_includes_runtime_options() {
    let opts = WrapperOptions {
        volumes: vec!["/h:/c:ro".to_string()],
        env: vec!["TOKEN=abc".to_string()],
        privileged: true,
        network: Some("hive-formal-ai".to_string()),
        networks: vec!["hive-formal-ai".to_string(), "public-egress".to_string()],
        network_aliases: vec!["formal-ai".to_string(), "checker".to_string()],
        ..Default::default()
    };
    let map = build_isolation_options_map(
        Some("docker"),
        "attached",
        "s",
        Some("konard/hive-mind-dind:latest"),
        &opts,
        Some("isolated-user"),
    );
    assert_eq!(
        map.get("volumes"),
        Some(&serde_json::json!(["/h:/c:ro".to_string()]))
    );
    assert_eq!(
        map.get("env"),
        Some(&serde_json::json!(["TOKEN=abc".to_string()]))
    );
    assert_eq!(map.get("privileged"), Some(&serde_json::Value::Bool(true)));
    assert_eq!(
        map.get("network"),
        Some(&serde_json::json!("hive-formal-ai"))
    );
    assert_eq!(
        map.get("networks"),
        Some(&serde_json::json!(["hive-formal-ai", "public-egress"]))
    );
    assert_eq!(
        map.get("networkAliases"),
        Some(&serde_json::json!(["formal-ai", "checker"]))
    );
    assert_eq!(map.get("user"), Some(&serde_json::json!("isolated-user")));
}
