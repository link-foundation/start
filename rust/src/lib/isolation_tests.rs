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
