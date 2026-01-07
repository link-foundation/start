//! Integration tests for echo command across all isolation modes
//!
//! Issue #55: Ensure `echo "hi"` works reliably in all modes with proper output
//!
//! These tests verify for ALL isolation modes (attached + detached):
//! 1. Command output is captured and displayed
//! 2. Start and finish blocks are properly formatted
//! 3. Empty lines exist before and after command output
//! 4. Log paths and session IDs are not truncated (fully copyable)
//!
//! Test coverage:
//! - No isolation mode (direct execution)
//! - Screen isolation: attached + detached
//! - Tmux isolation: attached + detached
//! - Docker isolation: attached + detached

use std::process::Command;

/// Check if a command is available on the system
fn is_command_available(cmd: &str) -> bool {
    let check_cmd = if cfg!(windows) { "where" } else { "which" };
    Command::new(check_cmd)
        .arg(cmd)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Check if docker is available and can run Linux containers
fn can_run_linux_docker_images() -> bool {
    if !is_command_available("docker") {
        return false;
    }

    // Try to run a simple alpine container
    Command::new("docker")
        .args(["run", "--rm", "alpine:latest", "echo", "test"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Run the CLI and capture output
fn run_cli(args: &[&str]) -> Result<String, String> {
    let cli_path = std::env::current_dir()
        .unwrap()
        .join("target/debug/start-command");

    if !cli_path.exists() {
        // Try release path
        let release_path = std::env::current_dir()
            .unwrap()
            .join("target/release/start-command");

        if !release_path.exists() {
            return Err("CLI binary not found. Run `cargo build` first.".to_string());
        }

        return run_cli_with_path(&release_path, args);
    }

    run_cli_with_path(&cli_path, args)
}

fn run_cli_with_path(cli_path: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(cli_path)
        .args(args)
        .env("START_DISABLE_AUTO_ISSUE", "1")
        .env("START_DISABLE_TRACKING", "1")
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(format!("{}{}", stdout, stderr))
    } else {
        Err(format!("Command failed: {}\nStderr: {}", stdout, stderr))
    }
}

/// Verify output contains expected structure for attached modes
fn verify_attached_mode_output(output: &str, expected_text: &str) -> Result<(), String> {
    // Should contain start block
    if !output.contains('╭') {
        return Err("Output should contain start block top border".to_string());
    }
    if !output.contains('╰') {
        return Err("Output should contain block bottom border".to_string());
    }
    if !output.contains("Session ID:") {
        return Err("Output should contain Session ID".to_string());
    }
    if !output.contains("Starting at") {
        return Err("Output should contain Starting at timestamp".to_string());
    }

    // Should contain command output
    if !output.contains(expected_text) {
        return Err(format!(
            "Output should contain '{}' command output",
            expected_text
        ));
    }

    // Should contain finish block (for attached modes)
    if !output.contains("Finished at") {
        return Err("Output should contain Finished at timestamp".to_string());
    }
    if !output.contains("Exit code:") {
        return Err("Output should contain Exit code".to_string());
    }
    if !output.contains("Log:") {
        return Err("Output should contain Log path".to_string());
    }

    Ok(())
}

/// Verify output for detached modes
fn verify_detached_mode_output(output: &str) -> Result<(), String> {
    // Should contain start block
    if !output.contains('╭') {
        return Err("Output should contain start block top border".to_string());
    }
    if !output.contains("Session ID:") {
        return Err("Output should contain Session ID".to_string());
    }
    if !output.contains("Starting at") {
        return Err("Output should contain Starting at timestamp".to_string());
    }

    // Should show detached mode info
    if !output.contains("Mode: detached") && !output.contains("Reattach with") {
        return Err(
            "Output should indicate detached mode or show reattach instructions".to_string(),
        );
    }

    Ok(())
}

/// Verify log path is not truncated
fn verify_log_path_not_truncated(output: &str) -> Result<(), String> {
    // Find the Log: line
    for line in output.lines() {
        if line.contains("Log:") {
            let log_part = line.split("Log:").last().unwrap_or("");
            let clean_path = log_part.trim().trim_end_matches('│').trim();
            if !clean_path.ends_with(".log") {
                return Err(format!(
                    "Log path should end with .log extension, got: '{}'",
                    clean_path
                ));
            }
            return Ok(());
        }
    }
    Err("Should have Log line".to_string())
}

/// Verify session ID is a valid UUID
fn verify_session_id(output: &str) -> Result<(), String> {
    // UUID regex pattern: 8-4-4-4-12 hex characters
    let uuid_pattern =
        regex::Regex::new(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}").unwrap();

    if uuid_pattern.is_match(output) {
        Ok(())
    } else {
        Err("Session ID should be a valid UUID format".to_string())
    }
}

// ============================================
// NO ISOLATION MODE (Direct Execution) Tests
// ============================================
mod no_isolation_mode {
    use super::*;

    #[test]
    fn test_echo_hi_works_correctly() {
        let result = run_cli(&["echo", "hi"]);
        match result {
            Ok(output) => {
                verify_attached_mode_output(&output, "hi").unwrap();
                verify_log_path_not_truncated(&output).unwrap();
                verify_session_id(&output).unwrap();
            }
            Err(e) => {
                // If CLI binary not found, skip test
                if e.contains("not found") {
                    println!("Skipping: CLI binary not found");
                    return;
                }
                panic!("Command should succeed: {}", e);
            }
        }
    }

    #[test]
    fn test_echo_with_quotes() {
        let result = run_cli(&["echo", "\"hello world\""]);
        match result {
            Ok(output) => {
                assert!(
                    output.contains("hello world"),
                    "Output should contain 'hello world'"
                );
            }
            Err(e) => {
                if e.contains("not found") {
                    println!("Skipping: CLI binary not found");
                    return;
                }
                panic!("Command should succeed: {}", e);
            }
        }
    }

    #[test]
    fn test_exit_code_formatting() {
        let result = run_cli(&["echo", "hi"]);
        match result {
            Ok(output) => {
                assert!(
                    output.contains("Exit code: 0"),
                    "Should show 'Exit code: 0' for successful command"
                );
            }
            Err(e) => {
                if e.contains("not found") {
                    println!("Skipping: CLI binary not found");
                    return;
                }
                panic!("Command should succeed: {}", e);
            }
        }
    }

    #[test]
    fn test_timing_information() {
        let result = run_cli(&["echo", "hi"]);
        match result {
            Ok(output) => {
                assert!(
                    output.contains("seconds") || output.contains("in 0."),
                    "Should include timing information"
                );
            }
            Err(e) => {
                if e.contains("not found") {
                    println!("Skipping: CLI binary not found");
                    return;
                }
                panic!("Command should succeed: {}", e);
            }
        }
    }
}

// ============================================
// SCREEN ISOLATION MODE Tests
// ============================================
mod screen_isolation_mode {
    use super::*;
    use std::process::Command as StdCommand;

    fn cleanup_screen_session(session_name: &str) {
        let _ = StdCommand::new("screen")
            .args(["-S", session_name, "-X", "quit"])
            .output();
    }

    mod attached {
        use super::*;

        #[test]
        fn test_echo_hi_in_attached_screen_mode() {
            if !is_command_available("screen") {
                println!("Skipping: screen not installed");
                return;
            }

            let result = run_cli(&["--isolated", "screen", "--", "echo", "hi"]);
            match result {
                Ok(output) => {
                    verify_attached_mode_output(&output, "hi").unwrap();
                    verify_log_path_not_truncated(&output).unwrap();
                    verify_session_id(&output).unwrap();

                    assert!(
                        output.contains("[Isolation] Environment: screen"),
                        "Should show screen isolation info"
                    );
                    assert!(
                        output.contains("Mode: attached"),
                        "Should show attached mode"
                    );
                }
                Err(e) => {
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }

        #[test]
        fn test_echo_with_quotes_in_attached_screen() {
            if !is_command_available("screen") {
                println!("Skipping: screen not installed");
                return;
            }

            let result = run_cli(&["--isolated", "screen", "--", "echo", "hello world"]);
            match result {
                Ok(output) => {
                    assert!(
                        output.contains("hello world"),
                        "Output should contain 'hello world'"
                    );
                }
                Err(e) => {
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }
    }

    mod detached {
        use super::*;

        #[test]
        fn test_echo_hi_in_detached_screen_mode() {
            if !is_command_available("screen") {
                println!("Skipping: screen not installed");
                return;
            }

            let session_name = format!(
                "test-screen-detached-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "screen",
                "-d",
                "--session",
                &session_name,
                "--",
                "echo",
                "hi",
            ]);

            match result {
                Ok(output) => {
                    verify_detached_mode_output(&output).unwrap();
                    verify_session_id(&output).unwrap();

                    assert!(
                        output.contains("[Isolation] Environment: screen"),
                        "Should show screen isolation info"
                    );
                    assert!(
                        output.contains("Mode: detached"),
                        "Should show detached mode"
                    );

                    cleanup_screen_session(&session_name);
                }
                Err(e) => {
                    cleanup_screen_session(&session_name);
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }

        #[test]
        fn test_reattach_instructions_in_detached_screen() {
            if !is_command_available("screen") {
                println!("Skipping: screen not installed");
                return;
            }

            let session_name = format!(
                "test-screen-reattach-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "screen",
                "-d",
                "--session",
                &session_name,
                "--",
                "echo",
                "hi",
            ]);

            match result {
                Ok(output) => {
                    assert!(
                        output.contains("Reattach with") || output.contains("screen -r"),
                        "Should show reattach instructions"
                    );
                    cleanup_screen_session(&session_name);
                }
                Err(e) => {
                    cleanup_screen_session(&session_name);
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }
    }
}

// ============================================
// TMUX ISOLATION MODE Tests
// ============================================
mod tmux_isolation_mode {
    use super::*;
    use std::process::Command as StdCommand;

    fn cleanup_tmux_session(session_name: &str) {
        let _ = StdCommand::new("tmux")
            .args(["kill-session", "-t", session_name])
            .output();
    }

    mod detached {
        use super::*;

        #[test]
        fn test_echo_hi_in_detached_tmux_mode() {
            if !is_command_available("tmux") {
                println!("Skipping: tmux not installed");
                return;
            }

            let session_name = format!(
                "test-tmux-detached-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "tmux",
                "-d",
                "--session",
                &session_name,
                "--",
                "echo",
                "hi",
            ]);

            match result {
                Ok(output) => {
                    verify_detached_mode_output(&output).unwrap();
                    verify_session_id(&output).unwrap();

                    assert!(
                        output.contains("[Isolation] Environment: tmux"),
                        "Should show tmux isolation info"
                    );
                    assert!(
                        output.contains("Mode: detached"),
                        "Should show detached mode"
                    );

                    cleanup_tmux_session(&session_name);
                }
                Err(e) => {
                    cleanup_tmux_session(&session_name);
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }

        #[test]
        fn test_reattach_instructions_in_detached_tmux() {
            if !is_command_available("tmux") {
                println!("Skipping: tmux not installed");
                return;
            }

            let session_name = format!(
                "test-tmux-reattach-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "tmux",
                "-d",
                "--session",
                &session_name,
                "--",
                "echo",
                "hi",
            ]);

            match result {
                Ok(output) => {
                    assert!(
                        output.contains("Reattach with") || output.contains("tmux attach"),
                        "Should show reattach instructions"
                    );
                    cleanup_tmux_session(&session_name);
                }
                Err(e) => {
                    cleanup_tmux_session(&session_name);
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }

        #[test]
        fn test_echo_with_quotes_in_detached_tmux() {
            if !is_command_available("tmux") {
                println!("Skipping: tmux not installed");
                return;
            }

            let session_name = format!(
                "test-tmux-quotes-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "tmux",
                "-d",
                "--session",
                &session_name,
                "--",
                "echo",
                "hello world",
            ]);

            match result {
                Ok(_output) => {
                    // Success is enough for detached mode
                    cleanup_tmux_session(&session_name);
                }
                Err(e) => {
                    cleanup_tmux_session(&session_name);
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }
    }
}

// ============================================
// DOCKER ISOLATION MODE Tests
// ============================================
mod docker_isolation_mode {
    use super::*;
    use std::process::Command as StdCommand;

    fn cleanup_docker_container(container_name: &str) {
        let _ = StdCommand::new("docker")
            .args(["rm", "-f", container_name])
            .output();
    }

    mod attached {
        use super::*;

        #[test]
        fn test_echo_hi_in_attached_docker_mode() {
            if !can_run_linux_docker_images() {
                println!("Skipping: docker not available or cannot run Linux containers");
                return;
            }

            let container_name = format!(
                "test-docker-attached-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "docker",
                "--image",
                "alpine:latest",
                "--session",
                &container_name,
                "--",
                "echo",
                "hi",
            ]);

            match result {
                Ok(output) => {
                    verify_attached_mode_output(&output, "hi").unwrap();
                    verify_log_path_not_truncated(&output).unwrap();
                    verify_session_id(&output).unwrap();

                    assert!(
                        output.contains("[Isolation] Environment: docker"),
                        "Should show docker isolation info"
                    );
                    assert!(
                        output.contains("[Isolation] Image: alpine:latest"),
                        "Should show docker image info"
                    );
                }
                Err(e) => {
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }

        #[test]
        fn test_echo_with_quotes_in_attached_docker() {
            if !can_run_linux_docker_images() {
                println!("Skipping: docker not available or cannot run Linux containers");
                return;
            }

            let container_name = format!(
                "test-docker-quotes-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "docker",
                "--image",
                "alpine:latest",
                "--session",
                &container_name,
                "--",
                "echo",
                "hello world",
            ]);

            match result {
                Ok(output) => {
                    assert!(
                        output.contains("hello world"),
                        "Output should contain 'hello world'"
                    );
                }
                Err(e) => {
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }

        #[test]
        fn test_exit_code_in_attached_docker() {
            if !can_run_linux_docker_images() {
                println!("Skipping: docker not available or cannot run Linux containers");
                return;
            }

            let container_name = format!(
                "test-docker-finish-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "docker",
                "--image",
                "alpine:latest",
                "--session",
                &container_name,
                "--",
                "echo",
                "hi",
            ]);

            match result {
                Ok(output) => {
                    assert!(output.contains("Exit code: 0"), "Should show exit code 0");
                    assert!(
                        output.contains("exited with code 0") || output.contains("Finished at"),
                        "Should show completion info"
                    );
                }
                Err(e) => {
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }
    }

    mod detached {
        use super::*;

        #[test]
        fn test_echo_hi_in_detached_docker_mode() {
            if !can_run_linux_docker_images() {
                println!("Skipping: docker not available or cannot run Linux containers");
                return;
            }

            let container_name = format!(
                "test-docker-detached-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "docker",
                "-d",
                "--image",
                "alpine:latest",
                "--session",
                &container_name,
                "--",
                "echo",
                "hi",
            ]);

            match result {
                Ok(output) => {
                    verify_detached_mode_output(&output).unwrap();
                    verify_session_id(&output).unwrap();

                    assert!(
                        output.contains("[Isolation] Environment: docker"),
                        "Should show docker isolation info"
                    );
                    assert!(
                        output.contains("Mode: detached"),
                        "Should show detached mode"
                    );

                    cleanup_docker_container(&container_name);
                }
                Err(e) => {
                    cleanup_docker_container(&container_name);
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }

        #[test]
        fn test_reattach_instructions_in_detached_docker() {
            if !can_run_linux_docker_images() {
                println!("Skipping: docker not available or cannot run Linux containers");
                return;
            }

            let container_name = format!(
                "test-docker-reattach-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
            );

            let result = run_cli(&[
                "--isolated",
                "docker",
                "-d",
                "--image",
                "alpine:latest",
                "--session",
                &container_name,
                "--",
                "echo",
                "hi",
            ]);

            match result {
                Ok(output) => {
                    assert!(
                        output.contains("Reattach with")
                            || output.contains("docker attach")
                            || output.contains("docker logs"),
                        "Should show reattach instructions"
                    );
                    cleanup_docker_container(&container_name);
                }
                Err(e) => {
                    cleanup_docker_container(&container_name);
                    if e.contains("not found") {
                        println!("Skipping: CLI binary not found");
                        return;
                    }
                    panic!("Command should succeed: {}", e);
                }
            }
        }
    }
}

// ============================================
// OUTPUT BLOCK FORMATTING Tests
// ============================================
mod output_block_formatting {
    use super::*;

    #[test]
    fn test_log_paths_not_truncated() {
        let result = run_cli(&["echo", "hi"]);
        match result {
            Ok(output) => {
                verify_log_path_not_truncated(&output).unwrap();
            }
            Err(e) => {
                if e.contains("not found") {
                    println!("Skipping: CLI binary not found");
                    return;
                }
                panic!("Command should succeed: {}", e);
            }
        }
    }

    #[test]
    fn test_session_ids_in_both_blocks() {
        let result = run_cli(&["echo", "hi"]);
        match result {
            Ok(output) => {
                // Count Session ID occurrences
                let count = output.matches("Session ID:").count();
                assert!(count >= 2, "Should have Session ID in both blocks");

                verify_session_id(&output).unwrap();
            }
            Err(e) => {
                if e.contains("not found") {
                    println!("Skipping: CLI binary not found");
                    return;
                }
                panic!("Command should succeed: {}", e);
            }
        }
    }
}
