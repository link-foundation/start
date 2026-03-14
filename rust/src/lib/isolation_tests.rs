use super::*;

#[test]
fn test_is_command_available() {
    // These should exist on most systems
    assert!(is_command_available("ls") || is_command_available("dir"));
}

#[test]
fn test_get_shell() {
    let (shell, arg) = get_shell();
    assert!(!shell.is_empty());
    assert!(!arg.is_empty());
}

#[test]
fn test_wrap_command_with_user() {
    let cmd = wrap_command_with_user("echo hello", None);
    assert_eq!(cmd, "echo hello");

    let cmd = wrap_command_with_user("echo hello", Some("testuser"));
    assert!(cmd.contains("sudo"));
    assert!(cmd.contains("testuser"));
}

#[test]
fn test_get_timestamp() {
    let ts = get_timestamp();
    assert!(ts.contains("-"));
    assert!(ts.contains(":"));
}

#[test]
fn test_generate_log_filename() {
    let name = generate_log_filename("test");
    assert!(name.starts_with("start-command-test-"));
    assert!(name.ends_with(".log"));
}

#[test]
fn test_create_log_path() {
    let path = create_log_path("test");
    assert!(path.to_string_lossy().contains("start-command-test-"));
}

#[test]
fn test_run_in_screen_captures_version_output() {
    // Issue #96: quick-completing commands like `node --version` must have their
    // output captured in screen isolation (was silently lost due to log flush timing).
    if !is_command_available("screen") {
        eprintln!("Skipping: screen not installed");
        return;
    }
    if !is_command_available("node") {
        eprintln!("Skipping: node not installed");
        return;
    }

    let result = run_in_screen(
        "node --version",
        &IsolationOptions {
            session: Some(format!(
                "test-version-flag-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            )),
            detached: false,
            ..Default::default()
        },
    );

    assert!(result.success, "Command should succeed");
    let output = result.output.unwrap_or_default();
    assert!(
        !output.trim().is_empty(),
        "Output should not be empty (issue #96: version output was silently lost)"
    );
    // node --version outputs something like "v20.0.0"
    assert!(
        output.contains('v') || output.chars().any(|c| c.is_ascii_digit()),
        "Output should contain version string, got: {:?}",
        output
    );
}

#[test]
fn test_run_in_screen_captures_exit_code() {
    // Issue #96: screen isolation should capture the actual exit code from the command,
    // not always report 0.
    if !is_command_available("screen") {
        eprintln!("Skipping: screen not installed");
        return;
    }

    let result = run_in_screen(
        "nonexistent_command_12345",
        &IsolationOptions {
            session: Some(format!(
                "test-exit-code-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            )),
            detached: false,
            ..Default::default()
        },
    );

    assert!(
        !result.success,
        "Command should fail (command not found)"
    );
    assert!(
        result.exit_code.is_some(),
        "Exit code should be captured"
    );
    let exit_code = result.exit_code.unwrap();
    assert_ne!(
        exit_code, 0,
        "Exit code should be non-zero for failed command, got: {}",
        exit_code
    );
}

#[test]
fn test_run_in_screen_captures_stderr() {
    // Issue #96: stderr should be captured via screen's logging mechanism
    if !is_command_available("screen") {
        eprintln!("Skipping: screen not installed");
        return;
    }

    let result = run_in_screen(
        "echo stderr-test >&2",
        &IsolationOptions {
            session: Some(format!(
                "test-stderr-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            )),
            detached: false,
            ..Default::default()
        },
    );

    assert!(result.success, "Command should succeed");
    let output = result.output.unwrap_or_default();
    assert!(
        output.contains("stderr-test"),
        "stderr output should be captured, got: {:?}",
        output
    );
}
