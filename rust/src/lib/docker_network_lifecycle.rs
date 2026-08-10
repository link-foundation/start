//! Pre-start Docker network attachment helpers.

use std::process::Command;

use crate::docker_cleanup::{docker_command, docker_networks};
use crate::isolation::IsolationOptions;

fn run_docker_command(args: &[&str]) -> Result<String, String> {
    let output = Command::new(docker_command())
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
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
    for network in docker_networks(options).into_iter().skip(1) {
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
