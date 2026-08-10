//! Real-daemon integration coverage for Docker network isolation (issues #154, #156, #158).

use start_command::isolation::run_in_docker;
use start_command::IsolationOptions;
use std::process::Command;
use uuid::Uuid;

fn docker(args: &[&str]) -> std::process::Output {
    Command::new("docker").args(args).output().unwrap()
}

struct DockerResources {
    networks: Vec<String>,
    containers: Vec<String>,
}

impl Drop for DockerResources {
    fn drop(&mut self) {
        let mut rm_args = vec!["rm", "-f"];
        rm_args.extend(self.containers.iter().map(String::as_str));
        let _ = docker(&rm_args);
        let mut network_args = vec!["network", "rm"];
        network_args.extend(self.networks.iter().map(String::as_str));
        let _ = docker(&network_args);
    }
}

/// Container output, folded into assertion messages so a CI failure carries the
/// evidence needed to diagnose it instead of only reporting the exit code.
fn container_diagnostics(name: &str) -> String {
    let logs = docker(&["logs", name]);
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&logs.stdout),
        String::from_utf8_lossy(&logs.stderr)
    );
    let output = output.trim().to_string();
    format!(
        "\n--- docker logs {name} ---\n{}\n---",
        if output.is_empty() {
            "<no output>".to_string()
        } else {
            output
        }
    )
}

fn create_internal_network_with_sidecar(network: &str, container: &str, alias: &str) {
    let created = docker(&["network", "create", "--internal", network]);
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let started = docker(&[
        "run",
        "-d",
        "--name",
        container,
        "--network",
        network,
        "--network-alias",
        alias,
        "alpine:3.23",
        "sleep",
        "300",
    ]);
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
}

#[test]
fn named_network_alias_is_private_and_missing_network_leaves_no_orphan() {
    if !cfg!(target_os = "linux") {
        eprintln!("Skipping: this integration test requires Linux containers");
        return;
    }
    let docker_info = Command::new("docker").arg("info").output();
    if !matches!(docker_info, Ok(output) if output.status.success()) {
        eprintln!("Skipping: Docker daemon is unavailable");
        return;
    }

    let suffix = &Uuid::new_v4().to_string()[..8];
    let network = format!("start-rust-network-{suffix}");
    let second_network = format!("start-rust-network-b-{suffix}");
    let sidecar = format!("start-rust-sidecar-{suffix}");
    let second_sidecar = format!("start-rust-sidecar-b-{suffix}");
    let connected = format!("start-rust-connected-{suffix}");
    let control = format!("start-rust-control-{suffix}");
    let missing = format!("start-rust-missing-{suffix}");
    let _resources = DockerResources {
        networks: vec![network.clone(), second_network.clone()],
        containers: vec![
            sidecar.clone(),
            second_sidecar.clone(),
            connected.clone(),
            control.clone(),
            missing.clone(),
        ],
    };

    create_internal_network_with_sidecar(&network, &sidecar, "formal-ai");
    create_internal_network_with_sidecar(&second_network, &second_sidecar, "formal-db");

    // Both endpoints are local, user-defined networks on purpose: probing a
    // public endpoint (previously `https://api.github.com`) made this test fail
    // whenever the shared runner IP hit the 60 requests/hour unauthenticated
    // GitHub API rate limit (issue #158).
    let joined = run_in_docker(
        "ping -c 1 formal-ai && ping -c 1 formal-db",
        &IsolationOptions {
            image: Some("alpine:3.23".to_string()),
            session: Some(connected),
            network: Some(network.clone()),
            networks: vec![network.clone(), second_network.clone()],
            detached: true,
            shell: "sh".to_string(),
            keep_container: true,
            ..Default::default()
        },
    );
    assert!(joined.success, "{}", joined.message);
    let joined_name = joined.session_name.as_deref().unwrap();
    let joined_exit = docker(&["wait", joined_name]);
    assert!(joined_exit.status.success());
    assert_eq!(
        String::from_utf8_lossy(&joined_exit.stdout).trim(),
        "0",
        "container did not exit cleanly{}",
        container_diagnostics(joined_name)
    );

    let unconnected = run_in_docker(
        "ping -c 1 formal-ai",
        &IsolationOptions {
            image: Some("alpine:3.23".to_string()),
            session: Some(control),
            shell: "sh".to_string(),
            always_cleanup_container: true,
            ..Default::default()
        },
    );
    assert!(!unconnected.success);

    let absent_network = format!("{network}-absent");
    let failed = run_in_docker(
        "echo should-not-run",
        &IsolationOptions {
            image: Some("alpine:3.23".to_string()),
            session: Some(missing.clone()),
            network: Some(absent_network),
            detached: true,
            shell: "sh".to_string(),
            ..Default::default()
        },
    );
    assert!(!failed.success);
    assert!(!docker(&["inspect", &missing]).status.success());

    let failed_second = run_in_docker(
        "echo should-not-run",
        &IsolationOptions {
            image: Some("alpine:3.23".to_string()),
            session: Some(missing.clone()),
            network: Some(network.clone()),
            networks: vec![network.clone(), format!("{network}-absent")],
            detached: true,
            shell: "sh".to_string(),
            ..Default::default()
        },
    );
    assert!(!failed_second.success);
    assert!(!docker(&["inspect", &missing]).status.success());

    let conflict = run_in_docker(
        "echo should-not-run",
        &IsolationOptions {
            image: Some("alpine:3.23".to_string()),
            session: Some(sidecar.clone()),
            network: Some(format!("{network}-absent")),
            detached: true,
            shell: "sh".to_string(),
            ..Default::default()
        },
    );
    assert!(!conflict.success);
    assert!(docker(&["inspect", &sidecar]).status.success());
}
