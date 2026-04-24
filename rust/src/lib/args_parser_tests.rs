use super::*;

#[test]
fn test_parse_simple_command() {
    let args: Vec<String> = vec!["echo", "hello", "world"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.command, "echo hello world");
    assert!(result.wrapper_options.isolated.is_none());
    assert!(!result.wrapper_options.attached);
    assert!(!result.wrapper_options.detached);
}

#[test]
fn test_parse_with_separator() {
    let args: Vec<String> = vec!["--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.command, "npm test");
}

#[test]
fn test_parse_isolated_option() {
    let args: Vec<String> = vec!["--isolated", "tmux", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.isolated, Some("tmux".to_string()));
    assert_eq!(result.command, "npm test");
}

#[test]
fn test_parse_shorthand() {
    let args: Vec<String> = vec!["-i", "screen", "-d", "--", "npm", "start"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.isolated, Some("screen".to_string()));
    assert!(result.wrapper_options.detached);
}

#[test]
fn test_attached_detached_conflict() {
    let args: Vec<String> = vec!["--attached", "--detached", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_docker_uses_default_image() {
    let args: Vec<String> = vec!["--isolated", "docker", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.isolated, Some("docker".to_string()));
    // Should have a default image set (OS-matched)
    assert!(
        result.wrapper_options.image.is_some(),
        "Expected default image to be set"
    );
    // Should be one of the known default images
    let known_defaults = vec![
        "alpine:latest",
        "ubuntu:latest",
        "debian:latest",
        "archlinux:latest",
        "fedora:latest",
        "centos:latest",
    ];
    let image = result.wrapper_options.image.as_ref().unwrap();
    assert!(
        known_defaults.contains(&image.as_str()),
        "Expected image to be one of {:?}, got {}",
        known_defaults,
        image
    );
}

#[test]
fn test_docker_with_image() {
    let args: Vec<String> = vec![
        "--isolated",
        "docker",
        "--image",
        "node:20",
        "--",
        "npm",
        "test",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.isolated, Some("docker".to_string()));
    assert_eq!(result.wrapper_options.image, Some("node:20".to_string()));
}

#[test]
fn test_ssh_requires_endpoint() {
    let args: Vec<String> = vec!["--isolated", "ssh", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_ssh_with_endpoint() {
    let args: Vec<String> = vec!["--isolated", "ssh", "--endpoint", "user@host", "--", "ls"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.isolated, Some("ssh".to_string()));
    assert_eq!(
        result.wrapper_options.endpoint,
        Some("user@host".to_string())
    );
}

#[test]
fn test_isolated_user() {
    let args: Vec<String> = vec!["--isolated-user", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert!(result.wrapper_options.user);
    assert!(result.wrapper_options.user_name.is_none());
}

#[test]
fn test_isolated_user_with_name() {
    let args: Vec<String> = vec!["--isolated-user", "myuser", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert!(result.wrapper_options.user);
    assert_eq!(result.wrapper_options.user_name, Some("myuser".to_string()));
}

#[test]
fn test_generate_session_name() {
    let name1 = generate_session_name(None);
    let name2 = generate_session_name(None);
    assert!(name1.starts_with("start-"));
    assert_ne!(name1, name2);
}

#[test]
fn test_generate_session_name_with_prefix() {
    let name = generate_session_name(Some("custom"));
    assert!(name.starts_with("custom-"));
}

#[test]
fn test_has_isolation() {
    let mut options = WrapperOptions::default();
    assert!(!has_isolation(&options));
    options.isolated = Some("tmux".to_string());
    assert!(has_isolation(&options));
}

#[test]
fn test_get_effective_mode() {
    let mut options = WrapperOptions::default();
    assert_eq!(get_effective_mode(&options), "attached");
    options.detached = true;
    assert_eq!(get_effective_mode(&options), "detached");
}

#[test]
fn test_keep_user_requires_user() {
    let args: Vec<String> = vec!["--keep-user", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_use_command_stream() {
    let args: Vec<String> = vec!["--use-command-stream", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert!(result.wrapper_options.use_command_stream);
}

#[test]
fn test_status_option() {
    let args: Vec<String> = vec!["--status", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(
        result.wrapper_options.status,
        Some("a1b2c3d4-e5f6-7890-abcd-ef1234567890".to_string())
    );
}

#[test]
fn test_status_with_output_format() {
    let args: Vec<String> = vec![
        "--status",
        "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "--output-format",
        "json",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(
        result.wrapper_options.status,
        Some("a1b2c3d4-e5f6-7890-abcd-ef1234567890".to_string())
    );
    assert_eq!(
        result.wrapper_options.output_format,
        Some("json".to_string())
    );
}

#[test]
fn test_status_with_links_notation() {
    let args: Vec<String> = vec!["--status", "uuid-here", "--output-format", "links-notation"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(
        result.wrapper_options.output_format,
        Some("links-notation".to_string())
    );
}

#[test]
fn test_status_with_text_format() {
    let args: Vec<String> = vec!["--status", "uuid-here", "--output-format", "text"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(
        result.wrapper_options.output_format,
        Some("text".to_string())
    );
}

#[test]
fn test_status_equals_syntax() {
    let args: Vec<String> = vec!["--status=my-uuid-here"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(
        result.wrapper_options.status,
        Some("my-uuid-here".to_string())
    );
}

#[test]
fn test_output_format_equals_syntax() {
    let args: Vec<String> = vec!["--status=my-uuid", "--output-format=json"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(
        result.wrapper_options.output_format,
        Some("json".to_string())
    );
}

#[test]
fn test_list_option() {
    let args: Vec<String> = vec!["--list"].into_iter().map(String::from).collect();
    let result = parse_args(&args).unwrap();
    assert!(result.wrapper_options.list);
    assert!(result.command.is_empty());
}

#[test]
fn test_list_with_output_format() {
    let args: Vec<String> = vec!["--list", "--output-format", "json"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert!(result.wrapper_options.list);
    assert_eq!(
        result.wrapper_options.output_format,
        Some("json".to_string())
    );
}

#[test]
fn test_status_requires_uuid() {
    let args: Vec<String> = vec!["--status"].into_iter().map(String::from).collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_output_format_requires_format() {
    let args: Vec<String> = vec!["--status", "uuid", "--output-format"]
        .into_iter()
        .map(String::from)
        .collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_invalid_output_format() {
    let args: Vec<String> = vec!["--status", "uuid", "--output-format", "invalid"]
        .into_iter()
        .map(String::from)
        .collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_output_format_without_status() {
    let args: Vec<String> = vec!["--output-format", "json", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_cleanup_option() {
    let args: Vec<String> = vec!["--cleanup"].into_iter().map(String::from).collect();
    let result = parse_args(&args).unwrap();
    assert!(result.wrapper_options.cleanup);
    assert!(!result.wrapper_options.cleanup_dry_run);
}

#[test]
fn test_cleanup_dry_run_option() {
    let args: Vec<String> = vec!["--cleanup-dry-run"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert!(result.wrapper_options.cleanup);
    assert!(result.wrapper_options.cleanup_dry_run);
}

#[test]
fn test_shell_default_is_auto() {
    let args: Vec<String> = vec!["echo", "hello"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.shell, "auto");
}

#[test]
fn test_shell_bash() {
    let args: Vec<String> = vec![
        "--isolated",
        "docker",
        "--shell",
        "bash",
        "--",
        "npm",
        "test",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.shell, "bash");
}

#[test]
fn test_shell_zsh() {
    let args: Vec<String> = vec![
        "--isolated",
        "docker",
        "--shell",
        "zsh",
        "--",
        "npm",
        "test",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.shell, "zsh");
}

#[test]
fn test_shell_sh() {
    let args: Vec<String> = vec!["--isolated", "docker", "--shell", "sh", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.shell, "sh");
}

#[test]
fn test_shell_auto() {
    let args: Vec<String> = vec![
        "--isolated",
        "docker",
        "--shell",
        "auto",
        "--",
        "npm",
        "test",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.shell, "auto");
}

#[test]
fn test_shell_equals_syntax() {
    let args: Vec<String> = vec!["--isolated", "docker", "--shell=bash", "--", "npm", "test"]
        .into_iter()
        .map(String::from)
        .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.shell, "bash");
}

#[test]
fn test_shell_lowercase_normalization() {
    let args: Vec<String> = vec![
        "--isolated",
        "docker",
        "--shell",
        "BASH",
        "--",
        "npm",
        "test",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.shell, "bash");
}

#[test]
fn test_shell_invalid() {
    let args: Vec<String> = vec![
        "--isolated",
        "docker",
        "--shell",
        "fish",
        "--",
        "echo",
        "hi",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_shell_missing_argument() {
    let args: Vec<String> = vec!["--isolated", "docker", "--shell"]
        .into_iter()
        .map(String::from)
        .collect();
    assert!(parse_args(&args).is_err());
}

#[test]
fn test_shell_with_ssh() {
    let args: Vec<String> = vec![
        "--isolated",
        "ssh",
        "--endpoint",
        "user@host",
        "--shell",
        "bash",
        "--",
        "echo",
        "hi",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let result = parse_args(&args).unwrap();
    assert_eq!(result.wrapper_options.shell, "bash");
    assert_eq!(result.wrapper_options.isolated, Some("ssh".to_string()));
}
