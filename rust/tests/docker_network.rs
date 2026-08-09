//! Real-daemon integration coverage for Docker network isolation (issue #154).

use start_command::isolation::run_in_docker;
use start_command::IsolationOptions;
use std::process::Command;
use uuid::Uuid;

fn docker(args: &[&str]) -> std::process::Output {
    Command::new("docker").args(args).output().unwrap()
}

struct DockerResources {
    network: String,
    containers: Vec<String>,
}

impl Drop for DockerResources {
    fn drop(&mut self) {
        let mut rm_args = vec!["rm", "-f"];
        rm_args.extend(self.containers.iter().map(String::as_str));
        let _ = docker(&rm_args);
        let _ = docker(&["network", "rm", &self.network]);
    }
}

#[test]
fn named_network_alias_is_private_and_missing_network_leaves_no_orphan() {
    let docker_info = Command::new("docker").arg("info").output();
    if !matches!(docker_info, Ok(output) if output.status.success()) {
        eprintln!("Skipping: Docker daemon is unavailable");
        return;
    }

    let suffix = &Uuid::new_v4().to_string()[..8];
    let network = format!("start-rust-network-{suffix}");
    let sidecar = format!("start-rust-sidecar-{suffix}");
    let connected = format!("start-rust-connected-{suffix}");
    let control = format!("start-rust-control-{suffix}");
    let missing = format!("start-rust-missing-{suffix}");
    let _resources = DockerResources {
        network: network.clone(),
        containers: vec![
            sidecar.clone(),
            connected.clone(),
            control.clone(),
            missing.clone(),
        ],
    };

    let created = docker(&["network", "create", "--internal", &network]);
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let started = docker(&[
        "run",
        "-d",
        "--name",
        &sidecar,
        "--network",
        &network,
        "--network-alias",
        "formal-ai",
        "alpine:3.23",
        "sleep",
        "60",
    ]);
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );

    let joined = run_in_docker(
        "ping -c 1 formal-ai",
        &IsolationOptions {
            image: Some("alpine:3.23".to_string()),
            session: Some(connected),
            network: Some(network.clone()),
            network_aliases: vec!["task".to_string()],
            detached: true,
            shell: "sh".to_string(),
            keep_container: true,
            ..Default::default()
        },
    );
    assert!(joined.success, "{}", joined.message);
    let joined_exit = docker(&["wait", joined.session_name.as_deref().unwrap()]);
    assert!(joined_exit.status.success());
    assert_eq!(String::from_utf8_lossy(&joined_exit.stdout).trim(), "0");

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
