//! `start --version`: the version of start and of the isolation tools it
//! can use. Moved out of the binary to keep it under the file-size limit.

use std::process::{Command, Stdio};

/// Print version information
pub fn print_version(verbose: bool) {
    let version = env!("CARGO_PKG_VERSION");
    println!("start-command version: {} (Rust)", version);
    println!();

    println!("OS: {}", std::env::consts::OS);
    println!("Architecture: {}", std::env::consts::ARCH);
    println!();

    // Check for installed isolation tools
    println!("Isolation tools:");

    if verbose {
        println!("[verbose] Checking isolation tools...");
    }

    // Check screen
    if let Some(version) = get_tool_version("screen", "-v", verbose) {
        println!("  screen: {}", version);
    } else {
        println!("  screen: not installed");
    }

    // Check tmux
    if let Some(version) = get_tool_version("tmux", "-V", verbose) {
        println!("  tmux: {}", version);
    } else {
        println!("  tmux: not installed");
    }

    // Check docker
    if let Some(version) = get_tool_version("docker", "--version", verbose) {
        println!("  docker: {}", version);
    } else {
        println!("  docker: not installed");
    }
}

/// Get version of an installed tool
fn get_tool_version(tool_name: &str, version_flag: &str, verbose: bool) -> Option<String> {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };

    // Check if tool exists
    let exists = Command::new(which_cmd)
        .arg(tool_name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !exists {
        if verbose {
            println!("[verbose] {}: not found in PATH", tool_name);
        }
        return None;
    }

    // Get version
    let output = Command::new(tool_name).arg(version_flag).output().ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr).trim().to_string();

    if verbose {
        println!(
            "[verbose] {} {}: exit={}, output=\"{}\"",
            tool_name,
            version_flag,
            output.status.code().unwrap_or(-1),
            &combined[..100.min(combined.len())]
        );
    }

    if combined.is_empty() {
        return None;
    }

    combined.lines().next().map(String::from)
}
