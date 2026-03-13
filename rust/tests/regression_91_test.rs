//! Regression tests for issue #91:
//! "`bash -i -c "nvm --version"` was interpreted as `bash -i -c nvm --version`,
//!  and executed inside bash, instead of directly"
//!
//! Bug 1 — Quote stripping / wrong interpretation
//! Bug 2 — Executed inside bash (double-wrapping)
//!
//! Root cause: is_interactive_shell_command() only returned true for bare shells.
//! Commands that ARE a shell invocation but include -c fell into the else-branch,
//! creating a shell-inside-shell. The fix adds is_shell_invocation_with_args() +
//! build_shell_with_args_cmd_args() to pass such commands directly.
//!
//! Reference: https://github.com/link-foundation/start/issues/91
//! Fixed in: PR #92

use start_command::{
    build_shell_with_args_cmd_args, is_interactive_shell_command, is_shell_invocation_with_args,
};

mod is_shell_invocation_with_args_tests {
    use super::*;

    #[test]
    fn should_return_true_for_bash_i_c_nvm_version() {
        assert!(is_shell_invocation_with_args("bash -i -c nvm --version"));
    }

    #[test]
    fn should_return_true_for_bash_c_echo_hello() {
        assert!(is_shell_invocation_with_args("bash -c \"echo hello\""));
    }

    #[test]
    fn should_return_true_for_bash_c_echo_hello_no_quotes() {
        assert!(is_shell_invocation_with_args("bash -c echo hello"));
    }

    #[test]
    fn should_return_true_for_zsh_c_nvm_version() {
        assert!(is_shell_invocation_with_args("zsh -c nvm --version"));
    }

    #[test]
    fn should_return_true_for_sh_c_ls() {
        assert!(is_shell_invocation_with_args("sh -c ls"));
    }

    #[test]
    fn should_return_true_for_slash_bin_bash_c_echo_hi() {
        assert!(is_shell_invocation_with_args("/bin/bash -c echo hi"));
    }

    #[test]
    fn should_return_false_for_bare_bash() {
        assert!(!is_shell_invocation_with_args("bash"));
    }

    #[test]
    fn should_return_false_for_bash_i() {
        assert!(!is_shell_invocation_with_args("bash -i"));
    }

    #[test]
    fn should_return_false_for_bash_norc() {
        assert!(!is_shell_invocation_with_args("bash --norc"));
    }

    #[test]
    fn should_return_false_for_non_shell_commands() {
        assert!(!is_shell_invocation_with_args("npm test"));
        assert!(!is_shell_invocation_with_args("echo hello"));
        assert!(!is_shell_invocation_with_args("node -e console.log(1)"));
    }
}

mod build_shell_with_args_cmd_args_tests {
    use super::*;

    #[test]
    fn should_reconstruct_bash_i_c_nvm_version() {
        let result = build_shell_with_args_cmd_args("bash -i -c nvm --version");
        assert_eq!(result, vec!["bash", "-i", "-c", "nvm --version"]);
    }

    #[test]
    fn should_reconstruct_bash_c_echo_hello() {
        let result = build_shell_with_args_cmd_args("bash -c echo hello");
        assert_eq!(result, vec!["bash", "-c", "echo hello"]);
    }

    #[test]
    fn should_handle_single_word_script_bash_c_ls() {
        let result = build_shell_with_args_cmd_args("bash -c ls");
        assert_eq!(result, vec!["bash", "-c", "ls"]);
    }

    #[test]
    fn should_handle_zsh_with_c() {
        let result = build_shell_with_args_cmd_args("zsh -c nvm --version");
        assert_eq!(result, vec!["zsh", "-c", "nvm --version"]);
    }

    #[test]
    fn should_handle_slash_bin_bash_i_c_with_multi_word_script() {
        let result = build_shell_with_args_cmd_args("/bin/bash -i -c echo hello world");
        assert_eq!(result, vec!["/bin/bash", "-i", "-c", "echo hello world"]);
    }

    #[test]
    fn should_not_include_c_argument_inside_script_no_double_c() {
        let result = build_shell_with_args_cmd_args("bash -i -c nvm --version");
        // The script argument should be "nvm --version", not "nvm" with "--version" separate
        let script = result.last().unwrap();
        assert_eq!(script, "nvm --version");
        // Should have exactly one -c flag
        let c_count = result.iter().filter(|a| a.as_str() == "-c").count();
        assert_eq!(c_count, 1, "Should have exactly one -c flag: {:?}", result);
    }
}

mod docker_attached_cmd_args_regression_91_tests {
    use super::*;

    /// Helper: mirrors the attached-mode command-args construction in run_in_docker.
    fn build_attached_cmd_args(command: &str, shell_to_use: &str) -> Vec<String> {
        let shell_name = shell_to_use.rsplit('/').next().unwrap_or(shell_to_use);
        let shell_interactive_flag = match shell_name {
            "bash" | "zsh" => Some("-i"),
            _ => None,
        };
        let mut shell_cmd_args = vec![shell_to_use.to_string()];
        if let Some(flag) = shell_interactive_flag {
            shell_cmd_args.push(flag.to_string());
        }

        if is_interactive_shell_command(command) {
            // Bare shell: pass directly with explicit -i (issue #84 fix)
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
            return build_shell_with_args_cmd_args(command);
        }

        // Regular command: wrap in shell -c
        shell_cmd_args.push("-c".to_string());
        shell_cmd_args.push(command.to_string());
        shell_cmd_args
    }

    #[test]
    fn bash_i_c_nvm_version_should_pass_directly() {
        let args = build_attached_cmd_args("bash -i -c nvm --version", "/bin/bash");
        assert_eq!(args, vec!["bash", "-i", "-c", "nvm --version"]);
    }

    #[test]
    fn zsh_c_nvm_version_should_pass_directly() {
        let args = build_attached_cmd_args("zsh -c nvm --version", "/bin/bash");
        assert_eq!(args, vec!["zsh", "-c", "nvm --version"]);
    }

    #[test]
    fn bash_c_echo_hello_should_pass_directly() {
        let args = build_attached_cmd_args("bash -c echo hello", "/bin/bash");
        assert_eq!(args, vec!["bash", "-c", "echo hello"]);
    }

    #[test]
    fn should_not_introduce_second_bash_layer() {
        let args = build_attached_cmd_args("bash -i -c nvm --version", "/bin/bash");
        // Should NOT be: ["/bin/bash", "-i", "-c", "bash -i -c nvm --version"]
        // It SHOULD be: ["bash", "-i", "-c", "nvm --version"]
        // First element should be "bash" (user's command), not "/bin/bash" (outer shell)
        assert_eq!(args[0], "bash", "Should not be wrapped: {:?}", args);
        // The outer shell (/bin/bash) should NOT appear in the result
        assert!(
            !args.contains(&"/bin/bash".to_string()),
            "Should not wrap in outer shell: {:?}",
            args
        );
    }

    #[test]
    fn bare_bash_should_still_get_i_flag() {
        let args = build_attached_cmd_args("bash", "/bin/bash");
        assert_eq!(args, vec!["bash", "-i"]);
    }

    #[test]
    fn npm_test_should_be_wrapped_in_outer_shell_c() {
        let args = build_attached_cmd_args("npm test", "/bin/bash");
        assert!(
            args.contains(&"-c".to_string()),
            "npm test should be wrapped in shell -c"
        );
        // The outer shell should be /bin/bash
        assert_eq!(args[0], "/bin/bash");
    }

    #[test]
    fn npm_test_still_wrapped_in_outer_shell() {
        let args = build_attached_cmd_args("npm test", "/bin/bash");
        assert!(args.contains(&"npm test".to_string()));
        assert!(args.contains(&"-c".to_string()));
    }

    #[test]
    fn mutual_exclusion_bare_shell_and_shell_with_args() {
        // A command cannot be both a bare interactive shell AND a shell-with-args
        let test_cases = vec![
            "bash",
            "zsh",
            "bash -i",
            "bash -c echo hi",
            "bash -i -c nvm --version",
            "npm test",
            "echo hello",
        ];
        for cmd in test_cases {
            let is_bare = is_interactive_shell_command(cmd);
            let is_with_args = is_shell_invocation_with_args(cmd);
            assert!(
                !(is_bare && is_with_args),
                "'{}' should not be both bare-shell and shell-with-args",
                cmd
            );
        }
    }
}
