//! Integration tests for start-command.
//!
//! These tests verify the public API works correctly.

use start_command::{parse_args, validate_options, VALID_BACKENDS};

fn to_string_vec(strs: &[&str]) -> Vec<String> {
    strs.iter().map(|s| s.to_string()).collect()
}

mod args_parser_integration_tests {
    use super::*;

    #[test]
    fn test_parse_simple_command_integration() {
        let args = to_string_vec(&["echo", "hello"]);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.raw_command, vec!["echo", "hello"]);
        assert_eq!(parsed.command, "echo hello");
    }

    #[test]
    fn test_parse_isolated_mode_integration() {
        let args = to_string_vec(&["--isolated", "screen", "--", "echo", "test"]);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.wrapper_options.isolated.as_deref(), Some("screen"));
    }

    #[test]
    fn test_validate_options_valid_backends() {
        for backend in VALID_BACKENDS.iter() {
            // Docker requires --image, SSH requires --endpoint
            if *backend == "docker" || *backend == "ssh" {
                continue;
            }
            let args = to_string_vec(&["--isolated", *backend, "--", "echo", "test"]);
            let parsed = parse_args(&args).unwrap();
            let result = validate_options(&parsed.wrapper_options);
            assert!(result.is_ok(), "Backend '{}' should be valid", backend);
        }
    }

    #[test]
    fn test_parse_with_separator() {
        let args = to_string_vec(&["--attached", "--", "echo", "hello world"]);
        let parsed = parse_args(&args).unwrap();
        assert!(parsed.wrapper_options.attached);
        assert_eq!(parsed.raw_command, vec!["echo", "hello world"]);
    }

    #[test]
    fn test_parse_detached_mode() {
        let args = to_string_vec(&["--detached", "--", "echo", "background"]);
        let parsed = parse_args(&args).unwrap();
        assert!(parsed.wrapper_options.detached);
    }

    #[test]
    fn test_parse_with_session_name() {
        // --session requires --isolated
        let args = to_string_vec(&[
            "--isolated",
            "screen",
            "--session",
            "mysession",
            "--",
            "echo",
            "test",
        ]);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.wrapper_options.session.as_deref(), Some("mysession"));
    }

    #[test]
    fn test_docker_with_image() {
        let args = to_string_vec(&[
            "--isolated",
            "docker",
            "--image",
            "node:20",
            "--",
            "npm",
            "test",
        ]);
        let parsed = parse_args(&args).unwrap();
        assert_eq!(parsed.wrapper_options.isolated.as_deref(), Some("docker"));
        assert_eq!(parsed.wrapper_options.image.as_deref(), Some("node:20"));
    }
}

mod version_tests {
    #[test]
    fn test_cargo_version_format() {
        // Verify Cargo.toml version is accessible and valid
        let version = env!("CARGO_PKG_VERSION");
        assert!(!version.is_empty());
        assert!(
            version.starts_with("0."),
            "Version should follow semver format: {}",
            version
        );
    }

    #[test]
    fn test_package_name() {
        let name = env!("CARGO_PKG_NAME");
        assert_eq!(name, "start-command");
    }

    #[test]
    fn test_package_has_description() {
        let description = env!("CARGO_PKG_DESCRIPTION");
        assert!(!description.is_empty());
    }
}
