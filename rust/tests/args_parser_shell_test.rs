//! Unit tests for shell option in the argument parser.
//!
//! Mirrors js/test/args-parser-shell.test.js

use start_command::{parse_args, VALID_SHELLS};

fn args(strs: &[&str]) -> Vec<String> {
    strs.iter().map(|s| s.to_string()).collect()
}

mod shell_option_tests {
    use super::*;

    #[test]
    fn should_default_shell_to_auto() {
        let result = parse_args(&args(&["echo", "hello"])).unwrap();
        assert_eq!(result.wrapper_options.shell, "auto");
    }

    #[test]
    fn should_parse_shell_bash() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--shell",
            "bash",
            "--",
            "npm",
            "test",
        ]))
        .unwrap();
        assert_eq!(result.wrapper_options.shell, "bash");
    }

    #[test]
    fn should_parse_shell_zsh() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--shell",
            "zsh",
            "--",
            "npm",
            "test",
        ]))
        .unwrap();
        assert_eq!(result.wrapper_options.shell, "zsh");
    }

    #[test]
    fn should_parse_shell_sh() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--shell",
            "sh",
            "--",
            "npm",
            "test",
        ]))
        .unwrap();
        assert_eq!(result.wrapper_options.shell, "sh");
    }

    #[test]
    fn should_parse_shell_auto() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--shell",
            "auto",
            "--",
            "npm",
            "test",
        ]))
        .unwrap();
        assert_eq!(result.wrapper_options.shell, "auto");
    }

    #[test]
    fn should_parse_shell_equals_value_format() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--shell=bash",
            "--",
            "npm",
            "test",
        ]))
        .unwrap();
        assert_eq!(result.wrapper_options.shell, "bash");
    }

    #[test]
    fn should_normalize_shell_to_lowercase() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--shell",
            "BASH",
            "--",
            "npm",
            "test",
        ]))
        .unwrap();
        assert_eq!(result.wrapper_options.shell, "bash");
    }

    #[test]
    fn should_error_for_missing_shell_argument() {
        let result = parse_args(&args(&["--isolated", "docker", "--shell"]));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("requires a shell argument"));
    }

    #[test]
    fn should_error_for_invalid_shell() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--shell",
            "fish",
            "--",
            "echo",
            "hi",
        ]));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid shell"));
    }

    #[test]
    fn error_should_list_valid_shells() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--shell",
            "invalid",
            "--",
            "echo",
            "test",
        ]));
        let err = result.unwrap_err();
        for shell in VALID_SHELLS.iter() {
            assert!(
                err.contains(shell),
                "Error should mention '{}': {}",
                shell,
                err
            );
        }
    }

    #[test]
    fn should_work_with_ssh_isolation() {
        let result = parse_args(&args(&[
            "--isolated",
            "ssh",
            "--endpoint",
            "user@host",
            "--shell",
            "bash",
            "--",
            "echo",
            "hi",
        ]))
        .unwrap();
        assert_eq!(result.wrapper_options.shell, "bash");
        assert_eq!(result.wrapper_options.isolated, Some("ssh".to_string()));
    }
}

mod valid_shells_tests {
    use super::*;

    #[test]
    fn should_include_bash() {
        assert!(VALID_SHELLS.contains(&"bash"));
    }

    #[test]
    fn should_include_zsh() {
        assert!(VALID_SHELLS.contains(&"zsh"));
    }

    #[test]
    fn should_include_sh() {
        assert!(VALID_SHELLS.contains(&"sh"));
    }

    #[test]
    fn should_include_auto() {
        assert!(VALID_SHELLS.contains(&"auto"));
    }
}
