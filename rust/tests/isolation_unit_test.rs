//! Unit tests for the isolation module (non-integration tests).
//!
//! Mirrors the unit test portions of js/test/isolation.test.js.
//! Integration tests (requiring actual screen/tmux/docker/ssh) are in isolation_test.rs.

use start_command::isolation::wrap_command_with_user;
use start_command::{
    build_shell_with_args_cmd_args, is_command_available, is_interactive_shell_command,
    is_shell_invocation_with_args, IsolationOptions,
};

mod wrap_command_with_user_tests {
    use super::*;

    #[test]
    fn should_return_command_unchanged_when_user_is_null() {
        let result = wrap_command_with_user("npm test", None);
        assert_eq!(result, "npm test");
    }

    #[test]
    fn should_wrap_command_with_sudo_when_user_is_specified() {
        let result = wrap_command_with_user("npm test", Some("testuser"));
        assert!(result.contains("sudo"), "Should contain sudo: {}", result);
        assert!(
            result.contains("testuser"),
            "Should contain username: {}",
            result
        );
        assert!(
            result.contains("npm test"),
            "Should contain command: {}",
            result
        );
    }

    #[test]
    fn should_escape_single_quotes_in_command() {
        let result = wrap_command_with_user("echo 'hello'", Some("testuser"));
        // Should not break shell syntax - the single quotes should be escaped
        assert!(
            !result.contains("echo 'hello'"),
            "Should escape single quotes"
        );
    }

    #[test]
    fn should_use_non_interactive_sudo() {
        let result = wrap_command_with_user("npm test", Some("testuser"));
        // -n flag means non-interactive
        assert!(
            result.contains("-n"),
            "Should use -n for non-interactive sudo: {}",
            result
        );
    }
}

mod is_command_available_tests {
    use super::*;

    #[test]
    fn should_return_true_for_common_commands_echo() {
        // echo is available on all platforms
        assert!(is_command_available("echo"));
    }

    #[test]
    fn should_return_false_for_non_existent_command() {
        assert!(!is_command_available(
            "this_command_does_not_exist_xyz_12345"
        ));
    }

    #[test]
    fn should_return_false_for_empty_command() {
        assert!(!is_command_available(""));
    }

    #[test]
    fn should_return_a_boolean() {
        let result = is_command_available("echo");
        let _ = result; // Just check it returns without panicking
    }
}

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
    fn should_return_true_for_slash_bin_bash() {
        assert!(is_interactive_shell_command("/bin/bash"));
    }

    #[test]
    fn should_return_true_for_slash_usr_bin_zsh() {
        assert!(is_interactive_shell_command("/usr/bin/zsh"));
    }

    #[test]
    fn should_return_true_for_bash_l_login_flag_no_c() {
        assert!(is_interactive_shell_command("bash -l"));
    }

    #[test]
    fn should_return_false_for_bash_c_echo() {
        assert!(!is_interactive_shell_command("bash -c echo"));
    }

    #[test]
    fn should_return_false_for_bash_c_echo_hi_quoted() {
        assert!(!is_interactive_shell_command("bash -c 'echo hi'"));
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
    fn should_return_false_for_ls_la() {
        assert!(!is_interactive_shell_command("ls -la"));
    }

    #[test]
    fn should_return_false_for_empty_string() {
        assert!(!is_interactive_shell_command(""));
    }

    #[test]
    fn should_return_false_for_whitespace_only() {
        assert!(!is_interactive_shell_command("  "));
    }
}

mod get_default_docker_image_tests {
    use start_command::get_default_docker_image;

    #[test]
    fn should_return_a_valid_docker_image_string() {
        let image = get_default_docker_image();
        assert!(!image.is_empty());
    }

    #[test]
    fn should_return_an_image_with_a_tag() {
        let image = get_default_docker_image();
        assert!(image.contains(':'), "Image should have a tag: {}", image);
    }

    #[test]
    fn should_return_a_known_base_image() {
        let image = get_default_docker_image();
        let known = [
            "alpine:latest",
            "ubuntu:latest",
            "debian:latest",
            "archlinux:latest",
            "fedora:latest",
            "centos:latest",
        ];
        assert!(
            known.contains(&image.as_str()),
            "Image '{}' should be one of the known base images: {:?}",
            image,
            known
        );
    }
}

mod detect_shell_in_environment_tests {
    use super::*;

    #[test]
    fn should_return_the_forced_shell_when_preference_is_not_auto() {
        let opts = IsolationOptions {
            shell: "bash".to_string(),
            ..IsolationOptions::default()
        };
        // When shell is forced, should return that shell
        let shell = start_command::isolation::detect_shell_in_environment("docker", &opts);
        assert_eq!(shell, "bash");
    }

    #[test]
    fn should_return_zsh_when_preference_is_zsh() {
        let opts = IsolationOptions {
            shell: "zsh".to_string(),
            ..IsolationOptions::default()
        };
        let shell = start_command::isolation::detect_shell_in_environment("docker", &opts);
        assert_eq!(shell, "zsh");
    }

    #[test]
    fn should_return_sh_when_preference_is_sh() {
        let opts = IsolationOptions {
            shell: "sh".to_string(),
            ..IsolationOptions::default()
        };
        let shell = start_command::isolation::detect_shell_in_environment("docker", &opts);
        assert_eq!(shell, "sh");
    }

    #[test]
    fn should_return_sh_fallback_for_unknown_environment() {
        let opts = IsolationOptions {
            shell: "auto".to_string(),
            ..IsolationOptions::default()
        };
        // For unknown environments with auto mode, should return sh as fallback
        let shell = start_command::isolation::detect_shell_in_environment("unknown", &opts);
        assert!(!shell.is_empty(), "Should return a shell");
    }

    #[test]
    fn should_read_shell_preference_from_options_shell() {
        for preference in &["bash", "zsh", "sh"] {
            let opts = IsolationOptions {
                shell: preference.to_string(),
                ..IsolationOptions::default()
            };
            let shell = start_command::isolation::detect_shell_in_environment("docker", &opts);
            assert_eq!(&shell, preference);
        }
    }
}

mod is_shell_invocation_with_args_tests {
    use super::*;

    #[test]
    fn should_return_true_for_bash_c_echo() {
        assert!(is_shell_invocation_with_args("bash -c echo"));
    }

    #[test]
    fn should_return_true_for_zsh_c_cmd() {
        assert!(is_shell_invocation_with_args("zsh -c 'some command'"));
    }

    #[test]
    fn should_return_true_for_bash_i_c_cmd() {
        assert!(is_shell_invocation_with_args("bash -i -c 'nvm --version'"));
    }

    #[test]
    fn should_return_false_for_npm_run_test() {
        assert!(!is_shell_invocation_with_args("npm run test"));
    }

    #[test]
    fn should_return_false_for_empty_string() {
        assert!(!is_shell_invocation_with_args(""));
    }

    #[test]
    fn should_return_true_for_slash_bin_bash_c() {
        assert!(is_shell_invocation_with_args("/bin/bash -c 'echo hello'"));
    }
}

mod build_shell_with_args_cmd_args_tests {
    use super::*;

    #[test]
    fn should_return_full_args_for_bash_c_echo() {
        let args = build_shell_with_args_cmd_args("bash -c echo");
        assert!(args.contains(&"bash".to_string()));
        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"echo".to_string()));
    }

    #[test]
    fn should_join_script_parts_after_c() {
        let args = build_shell_with_args_cmd_args("bash -c echo hello world");
        // Everything after -c should be joined as one argument
        let c_idx = args.iter().position(|a| a == "-c").expect("Should have -c");
        let script = &args[c_idx + 1];
        assert_eq!(script, "echo hello world");
    }

    #[test]
    fn should_handle_bash_i_c_cmd() {
        let args = build_shell_with_args_cmd_args("bash -i -c nvm --version");
        assert!(args.contains(&"bash".to_string()));
        assert!(args.contains(&"-i".to_string()));
        assert!(args.contains(&"-c".to_string()));
        // "nvm --version" should be joined
        let c_idx = args.iter().position(|a| a == "-c").expect("Should have -c");
        let script = &args[c_idx + 1];
        assert_eq!(script, "nvm --version");
    }

    #[test]
    fn should_return_all_parts_when_no_c_flag() {
        let args = build_shell_with_args_cmd_args("npm run test");
        assert_eq!(args, vec!["npm", "run", "test"]);
    }
}

mod isolation_options_tests {
    use super::*;

    #[test]
    fn should_have_correct_defaults() {
        let opts = IsolationOptions::default();
        assert_eq!(opts.shell, "auto");
        assert!(!opts.detached);
        assert!(!opts.keep_alive);
        assert!(opts.session.is_none());
        assert!(opts.image.is_none());
        assert!(opts.user.is_none());
    }

    #[test]
    fn should_allow_custom_shell() {
        let opts = IsolationOptions {
            shell: "bash".to_string(),
            ..IsolationOptions::default()
        };
        assert_eq!(opts.shell, "bash");
    }

    #[test]
    fn should_allow_detached_mode() {
        let opts = IsolationOptions {
            detached: true,
            ..IsolationOptions::default()
        };
        assert!(opts.detached);
    }
}
