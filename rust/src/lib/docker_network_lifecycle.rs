//! Pre-start Docker network attachment helpers.

use std::env;
use std::process::Command;

use crate::docker_cleanup::{docker_command, docker_networks};
use crate::isolation::IsolationOptions;

/// Opt-in tracing, off by default: the multi-network attachment sequence
/// (`docker create` -> `docker network connect` -> `docker start`) previously
/// failed in CI with nothing but an exit code to go on (issue #158). Enable
/// with `START_DEBUG=1` to see every docker invocation, its status and output.
fn is_debug() -> bool {
    env::var("START_DEBUG").is_ok_and(|v| v == "1" || v == "true")
}

fn debug_log(message: &str) {
    if is_debug() {
        eprintln!("[docker-network] {message}");
    }
}

fn run_docker_command(args: &[&str]) -> Result<String, String> {
    debug_log(&format!("$ docker {}", args.join(" ")));
    let output = Command::new(docker_command())
        .args(args)
        .output()
        .map_err(|error| {
            debug_log(&format!("spawn failed: {error}"));
            error.to_string()
        })?;
    if is_debug() {
        debug_log(&format!(
            "exit={} stdout={:?} stderr={:?}",
            output.status,
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("docker {} exited with {}", args[0], output.status)
    })
}

fn connect_additional_networks(
    container_name: &str,
    options: &IsolationOptions,
) -> Result<(), String> {
    let networks: Vec<&str> = docker_networks(options).into_iter().skip(1).collect();
    debug_log(&format!(
        "connecting {container_name} to additional networks: {}",
        if networks.is_empty() {
            "<none>".to_string()
        } else {
            networks.join(", ")
        }
    ));
    for network in networks {
        run_docker_command(&["network", "connect", network, container_name])?;
    }
    Ok(())
}

pub(crate) fn create_and_connect(
    create_args: &[&str],
    container_name: &str,
    options: &IsolationOptions,
) -> Result<String, String> {
    let container_id = run_docker_command(create_args)?;
    connect_additional_networks(container_name, options)?;
    Ok(container_id)
}

pub(crate) fn connect_and_start(
    container_name: &str,
    options: &IsolationOptions,
) -> Result<(), String> {
    connect_additional_networks(container_name, options)?;
    run_docker_command(&["start", container_name])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options_with(network: Option<&str>, networks: &[&str]) -> IsolationOptions {
        IsolationOptions {
            network: network.map(str::to_string),
            networks: networks.iter().map(|n| n.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn returns_an_empty_list_when_no_network_is_requested() {
        assert!(docker_networks(&options_with(None, &[])).is_empty());
    }

    #[test]
    fn wraps_a_single_network_into_a_list() {
        assert_eq!(
            docker_networks(&options_with(Some("bridge"), &[])),
            ["bridge"]
        );
    }

    #[test]
    fn prefers_the_explicit_networks_list_over_the_single_network() {
        assert_eq!(
            docker_networks(&options_with(Some("bridge"), &["a", "b"])),
            ["a", "b"]
        );
    }

    #[test]
    fn ignores_an_empty_networks_list_and_falls_back_to_network() {
        assert_eq!(
            docker_networks(&options_with(Some("bridge"), &[])),
            ["bridge"]
        );
    }

    #[test]
    fn keeps_verbose_output_switched_off_by_default() {
        // The test process never sets START_DEBUG, so tracing stays silent
        // unless a user opts in (issue #158).
        if env::var("START_DEBUG").is_ok() {
            eprintln!("Skipping: START_DEBUG is set in this environment");
            return;
        }
        assert!(!is_debug());
        debug_log("should not appear");
    }
}
