//! Regression tests for issue #84: "We should not run bash inside bash"
//!
//! These tests guard against the shell-inside-shell regression where
//! `$ --isolated docker -- bash` caused:
//!   docker run ... image /bin/bash -i -c bash   (WRONG: bash inside bash)
//! instead of:
//!   docker run ... image bash -i                 (CORRECT: bare shell with explicit -i)
//!
//! Reference: https://github.com/link-foundation/start/issues/84
//! Fixed in: PR #85 (v0.24.1) via is_interactive_shell_command()

use start_command::{is_interactive_shell_command, is_shell_invocation_with_args};

mod is_interactive_shell_command_tests {
    use super::*;

    #[test]
    fn should_return_true_for_bash() {
        assert!(is_interactive_shell_command("bash"));
    }

    #[test]
    fn should_return_true_for_zsh() {
        assert!(is_interactive_shell_command("zsh"));
    }

    #[test]
    fn should_return_true_for_sh() {
        assert!(is_interactive_shell_command("sh"));
    }

    #[test]
    fn should_return_true_for_bash_norc() {
        assert!(is_interactive_shell_command("bash --norc"));
    }

    #[test]
    fn should_return_true_for_zsh_no_rcs() {
        assert!(is_interactive_shell_command("zsh --no-rcs"));
    }

    #[test]
    fn should_return_true_for_bash_i_interactive_flag() {
        assert!(is_interactive_shell_command("bash -i"));
    }

    #[test]
    fn should_return_true_for_fish() {
        assert!(is_interactive_shell_command("fish"));
    }

    #[test]
    fn should_return_true_for_dash() {
        assert!(is_interactive_shell_command("dash"));
    }

    #[test]
    fn should_return_true_for_full_path_bash() {
        assert!(is_interactive_shell_command("/usr/local/bin/bash"));
    }

    #[test]
    fn should_return_false_for_bash_c_echo_hello() {
        assert!(!is_interactive_shell_command("bash -c \"echo hello\""));
    }

    #[test]
    fn should_return_false_for_npm_test() {
        assert!(!is_interactive_shell_command("npm test"));
    }

    #[test]
    fn should_return_false_for_echo_hello() {
        assert!(!is_interactive_shell_command("echo hello"));
    }

    #[test]
    fn should_return_false_for_empty_string() {
        assert!(!is_interactive_shell_command(""));
    }
}

mod build_cmd_args_regression_84_tests {
    use super::*;

    /// Helper that mirrors the attached-mode command-args construction logic in run_in_docker.
    /// Returns the argv array that would be passed to `docker run ... image <argv>`.
    fn build_cmd_args(command: &str, shell_to_use: &str) -> Vec<String> {
        let shell_name = shell_to_use.rsplit('/').next().unwrap_or(shell_to_use);
        let shell_interactive_flag = match shell_name {
            "bash" | "zsh" => Some("-i"),
            _ => None,
        };

        if is_interactive_shell_command(command) {
            // Bare shell: pass directly with explicit -i flag (issue #84 fix)
            let parts: Vec<&str> = command.split_whitespace().collect();
            let basename = parts[0].rsplit('/').next().unwrap_or(parts[0]);
            let bare_flag = match basename {
                "bash" | "zsh" => Some("-i"),
                _ => None,
            };
            if let Some(flag) = bare_flag {
                if !parts.contains(&flag) {
                    let mut result = vec![parts[0].to_string(), flag.to_string()];
                    result.extend(parts[1..].iter().map(|s| s.to_string()));
                    return result;
                }
            }
            return parts.iter().map(|s| s.to_string()).collect();
        } else if is_shell_invocation_with_args(command) {
            // Shell with -c: pass directly as argv (issue #91 fix)
            return start_command::build_shell_with_args_cmd_args(command);
        }

        // Regular command: wrap in shell -c
        let mut shell_cmd_args = vec![shell_to_use.to_string()];
        if let Some(flag) = shell_interactive_flag {
            shell_cmd_args.push(flag.to_string());
        }
        shell_cmd_args.push("-c".to_string());
        shell_cmd_args.push(command.to_string());
        shell_cmd_args
    }

    #[test]
    fn bash_should_get_i_flag_not_wrapped_in_shell_c() {
        let args = build_cmd_args("bash", "/bin/bash");
        assert_eq!(args, vec!["bash", "-i"]);
        assert!(
            !args.contains(&"-c".to_string()),
            "Must not contain -c flag"
        );
    }

    #[test]
    fn zsh_should_get_i_flag_not_wrapped_in_shell_c() {
        let args = build_cmd_args("zsh", "/bin/bash");
        assert_eq!(args, vec!["zsh", "-i"]);
        assert!(
            !args.contains(&"-c".to_string()),
            "Must not contain -c flag"
        );
    }

    #[test]
    fn sh_should_not_get_i_flag_not_wrapped_in_shell_c() {
        let args = build_cmd_args("sh", "/bin/bash");
        assert_eq!(args, vec!["sh"]);
        assert!(
            !args.contains(&"-c".to_string()),
            "Must not contain -c flag"
        );
    }

    #[test]
    fn npm_test_should_be_wrapped_in_shell_c() {
        let args = build_cmd_args("npm test", "/bin/bash");
        assert!(
            args.contains(&"-c".to_string()),
            "npm test should be wrapped in shell -c"
        );
        assert!(args.contains(&"npm test".to_string()));
    }

    #[test]
    fn echo_hello_should_be_wrapped_in_shell_c() {
        let args = build_cmd_args("echo hello", "/bin/bash");
        assert!(
            args.contains(&"-c".to_string()),
            "echo hello should be wrapped in shell -c"
        );
    }

    #[test]
    fn bash_already_has_i_flag_no_duplicate() {
        let args = build_cmd_args("bash -i", "/bin/bash");
        let i_count = args.iter().filter(|a| a.as_str() == "-i").count();
        assert_eq!(i_count, 1, "Should not have duplicate -i flags: {:?}", args);
    }
}
