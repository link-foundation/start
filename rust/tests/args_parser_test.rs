//! Comprehensive unit tests for the argument parser.
//!
//! Mirrors js/test/args-parser.test.js - covers gaps not already in args_parser_tests.rs (inline).

use start_command::{parse_args, validate_options, WrapperOptions, VALID_BACKENDS};

fn args(strs: &[&str]) -> Vec<String> {
    strs.iter().map(|s| s.to_string()).collect()
}

mod basic_command_parsing {
    use super::*;

    #[test]
    fn should_parse_empty_command_correctly() {
        let result = parse_args(&[]).unwrap();
        assert_eq!(result.command, "");
    }

    #[test]
    fn should_parse_isolated_equals_value_format() {
        let result = parse_args(&args(&["--isolated=tmux", "--", "ls"])).unwrap();
        assert_eq!(result.wrapper_options.isolated, Some("tmux".to_string()));
    }

    #[test]
    fn should_normalize_backend_to_lowercase() {
        let result = parse_args(&args(&["--isolated", "SCREEN", "--", "ls"])).unwrap();
        assert_eq!(result.wrapper_options.isolated, Some("screen".to_string()));
    }

    #[test]
    fn should_error_for_missing_backend_argument() {
        let result = parse_args(&args(&["--isolated"]));
        assert!(result.is_err());
    }

    #[test]
    fn should_parse_attached_flag() {
        let result = parse_args(&args(&["--attached", "--", "ls"])).unwrap();
        assert!(result.wrapper_options.attached);
    }

    #[test]
    fn should_parse_a_shorthand() {
        let result = parse_args(&args(&["-a", "--", "ls"])).unwrap();
        assert!(result.wrapper_options.attached);
    }

    #[test]
    fn should_parse_detached_flag() {
        let result = parse_args(&args(&["--detached", "--", "ls"])).unwrap();
        assert!(result.wrapper_options.detached);
    }

    #[test]
    fn should_parse_d_shorthand() {
        let result = parse_args(&args(&["-d", "--", "ls"])).unwrap();
        assert!(result.wrapper_options.detached);
    }

    #[test]
    fn should_provide_helpful_error_for_mode_conflict() {
        let result = parse_args(&args(&["--attached", "--detached", "--", "ls"]));
        assert!(result.is_err());
        let err = result.unwrap_err();
        // Should mention the conflict
        assert!(
            err.contains("attached") || err.contains("detached"),
            "Error should mention the conflicting options: {}",
            err
        );
    }

    #[test]
    fn should_parse_session_shorthand() {
        let result = parse_args(&args(&[
            "--isolated",
            "screen",
            "-s",
            "my-session",
            "--",
            "ls",
        ]))
        .unwrap();
        assert_eq!(
            result.wrapper_options.session,
            Some("my-session".to_string())
        );
    }

    #[test]
    fn should_parse_session_equals_format() {
        let result = parse_args(&args(&[
            "--isolated",
            "screen",
            "--session=my-session",
            "--",
            "ls",
        ]))
        .unwrap();
        assert_eq!(
            result.wrapper_options.session,
            Some("my-session".to_string())
        );
    }

    #[test]
    fn should_error_for_session_without_isolation() {
        let result = parse_args(&args(&["--session", "my-session", "--", "ls"]));
        assert!(result.is_err());
    }

    #[test]
    fn should_parse_image_equals_format() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--image=ubuntu:22.04",
            "--",
            "ls",
        ]))
        .unwrap();
        assert_eq!(
            result.wrapper_options.image,
            Some("ubuntu:22.04".to_string())
        );
    }

    #[test]
    fn should_error_for_image_with_non_docker_backend() {
        let result = parse_args(&args(&[
            "--isolated",
            "screen",
            "--image",
            "ubuntu:22.04",
            "--",
            "ls",
        ]));
        assert!(result.is_err());
    }

    #[test]
    fn should_parse_endpoint_equals_format() {
        let result = parse_args(&args(&[
            "--isolated",
            "ssh",
            "--endpoint=user@host",
            "--",
            "ls",
        ]))
        .unwrap();
        assert_eq!(
            result.wrapper_options.endpoint,
            Some("user@host".to_string())
        );
    }

    #[test]
    fn should_error_for_endpoint_with_non_ssh_backend() {
        let result = parse_args(&args(&[
            "--isolated",
            "screen",
            "--endpoint",
            "user@host",
            "--",
            "ls",
        ]));
        assert!(result.is_err());
    }

    #[test]
    fn should_parse_keep_alive_flag() {
        let result =
            parse_args(&args(&["--isolated", "screen", "--keep-alive", "--", "ls"])).unwrap();
        assert!(result.wrapper_options.keep_alive);
    }

    #[test]
    fn should_parse_k_shorthand() {
        let result = parse_args(&args(&["--isolated", "screen", "-k", "--", "ls"])).unwrap();
        assert!(result.wrapper_options.keep_alive);
    }

    #[test]
    fn should_default_keep_alive_to_false() {
        let result = parse_args(&args(&["ls"])).unwrap();
        assert!(!result.wrapper_options.keep_alive);
    }

    #[test]
    fn should_error_for_keep_alive_without_isolation() {
        let result = parse_args(&args(&["--keep-alive", "--", "ls"]));
        assert!(result.is_err());
    }

    #[test]
    fn keep_alive_should_work_with_detached_mode() {
        let result = parse_args(&args(&[
            "--isolated",
            "screen",
            "--detached",
            "--keep-alive",
            "--",
            "ls",
        ]))
        .unwrap();
        assert!(result.wrapper_options.keep_alive);
        assert!(result.wrapper_options.detached);
    }

    #[test]
    fn keep_alive_should_work_with_docker() {
        let result =
            parse_args(&args(&["--isolated", "docker", "--keep-alive", "--", "ls"])).unwrap();
        assert!(result.wrapper_options.keep_alive);
    }

    #[test]
    fn should_parse_auto_remove_docker_container_flag() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--auto-remove-docker-container",
            "--",
            "ls",
        ]))
        .unwrap();
        assert!(result.wrapper_options.auto_remove_docker_container);
    }

    #[test]
    fn should_default_auto_remove_docker_container_to_false() {
        let result = parse_args(&args(&["ls"])).unwrap();
        assert!(!result.wrapper_options.auto_remove_docker_container);
    }

    #[test]
    fn should_error_for_auto_remove_without_docker_isolation() {
        let result = parse_args(&args(&[
            "--isolated",
            "screen",
            "--auto-remove-docker-container",
            "--",
            "ls",
        ]));
        assert!(result.is_err());
    }

    #[test]
    fn should_error_for_auto_remove_without_isolation() {
        let result = parse_args(&args(&["--auto-remove-docker-container", "--", "ls"]));
        assert!(result.is_err());
    }

    #[test]
    fn auto_remove_and_keep_alive_can_coexist() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--keep-alive",
            "--auto-remove-docker-container",
            "--",
            "ls",
        ]))
        .unwrap();
        assert!(result.wrapper_options.keep_alive);
        assert!(result.wrapper_options.auto_remove_docker_container);
    }

    #[test]
    fn should_parse_command_after_options_without_separator() {
        let result = parse_args(&args(&["--attached", "npm", "test"])).unwrap();
        assert_eq!(result.command, "npm test");
    }

    #[test]
    fn should_handle_mixed_options_and_command() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--image",
            "node:20",
            "npm",
            "test",
        ]))
        .unwrap();
        assert_eq!(result.command, "npm test");
        assert_eq!(result.wrapper_options.image, Some("node:20".to_string()));
    }
}

mod validate_options_tests {
    use super::*;

    #[test]
    fn should_pass_for_valid_options() {
        let mut options = WrapperOptions {
            isolated: Some("screen".to_string()),
            ..WrapperOptions::default()
        };
        assert!(validate_options(&mut options).is_ok());
    }

    #[test]
    fn should_error_for_attached_and_detached_together() {
        let mut options = WrapperOptions {
            attached: true,
            detached: true,
            ..WrapperOptions::default()
        };
        assert!(validate_options(&mut options).is_err());
    }

    #[test]
    fn should_pass_for_docker_with_image() {
        let mut options = WrapperOptions {
            isolated: Some("docker".to_string()),
            image: Some("node:20".to_string()),
            ..WrapperOptions::default()
        };
        assert!(validate_options(&mut options).is_ok());
    }
}

mod valid_backends_tests {
    use super::*;

    #[test]
    fn should_include_screen() {
        assert!(VALID_BACKENDS.contains(&"screen"));
    }

    #[test]
    fn should_include_tmux() {
        assert!(VALID_BACKENDS.contains(&"tmux"));
    }

    #[test]
    fn should_include_docker() {
        assert!(VALID_BACKENDS.contains(&"docker"));
    }

    #[test]
    fn should_accept_all_valid_backends() {
        for backend in VALID_BACKENDS.iter() {
            // SSH requires endpoint, so skip for this check
            if *backend == "ssh" {
                continue;
            }
            let result = parse_args(&args(&["--isolated", backend, "--", "ls"]));
            assert!(
                result.is_ok(),
                "Backend '{}' should be valid: {:?}",
                backend,
                result
            );
        }
    }

    #[test]
    fn should_error_for_invalid_backend() {
        let result = parse_args(&args(&["--isolated", "invalid_backend", "--", "ls"]));
        assert!(result.is_err());
    }

    #[test]
    fn error_should_list_valid_backends() {
        let result = parse_args(&args(&["--isolated", "invalid", "--", "ls"]));
        let err = result.unwrap_err();
        for backend in VALID_BACKENDS.iter() {
            assert!(
                err.contains(backend),
                "Error should mention '{}': {}",
                backend,
                err
            );
        }
    }
}

mod use_command_stream_tests {
    use super::*;

    #[test]
    fn should_parse_use_command_stream_flag() {
        let result = parse_args(&args(&["--use-command-stream", "--", "npm", "test"])).unwrap();
        assert!(result.wrapper_options.use_command_stream);
    }

    #[test]
    fn should_default_use_command_stream_to_false() {
        let result = parse_args(&args(&["ls"])).unwrap();
        assert!(!result.wrapper_options.use_command_stream);
    }

    #[test]
    fn should_work_with_other_options() {
        let result = parse_args(&args(&[
            "--isolated",
            "screen",
            "--use-command-stream",
            "--",
            "npm",
            "test",
        ]))
        .unwrap();
        assert!(result.wrapper_options.use_command_stream);
        assert_eq!(result.wrapper_options.isolated, Some("screen".to_string()));
    }
}

mod keep_user_tests {
    use super::*;

    #[test]
    fn should_parse_keep_user_flag() {
        let result = parse_args(&args(&["--isolated-user", "--keep-user", "--", "ls"])).unwrap();
        assert!(result.wrapper_options.keep_user);
    }

    #[test]
    fn should_default_keep_user_to_false() {
        let result = parse_args(&args(&["ls"])).unwrap();
        assert!(!result.wrapper_options.keep_user);
    }

    #[test]
    fn should_error_for_keep_user_without_user() {
        let result = parse_args(&args(&["--keep-user", "--", "ls"]));
        assert!(result.is_err());
    }

    #[test]
    fn keep_user_should_work_with_user_and_isolation_options() {
        let result = parse_args(&args(&[
            "--isolated",
            "screen",
            "--isolated-user",
            "--keep-user",
            "--",
            "ls",
        ]))
        .unwrap();
        assert!(result.wrapper_options.keep_user);
        assert!(result.wrapper_options.user);
        assert_eq!(result.wrapper_options.isolated, Some("screen".to_string()));
    }
}

mod user_isolation_tests {
    use super::*;

    #[test]
    fn should_parse_u_shorthand() {
        let result = parse_args(&args(&["-u", "--", "npm", "test"])).unwrap();
        assert!(result.wrapper_options.user);
    }

    #[test]
    fn should_parse_u_with_custom_username() {
        let result = parse_args(&args(&["-u", "myrunner", "--", "npm", "test"])).unwrap();
        assert!(result.wrapper_options.user);
        assert_eq!(
            result.wrapper_options.user_name,
            Some("myrunner".to_string())
        );
    }

    #[test]
    fn should_parse_isolated_user_equals_value_format() {
        let result = parse_args(&args(&["--isolated-user=myrunner", "--", "npm", "test"])).unwrap();
        assert!(result.wrapper_options.user);
        assert_eq!(
            result.wrapper_options.user_name,
            Some("myrunner".to_string())
        );
    }

    #[test]
    fn should_work_without_isolation() {
        let result = parse_args(&args(&["--isolated-user", "--", "npm", "test"])).unwrap();
        assert!(result.wrapper_options.user);
        assert!(result.wrapper_options.isolated.is_none());
    }

    #[test]
    fn should_error_for_user_with_docker_isolation() {
        let result = parse_args(&args(&[
            "--isolated",
            "docker",
            "--isolated-user",
            "--",
            "ls",
        ]));
        assert!(result.is_err());
    }

    #[test]
    fn should_work_with_tmux_isolation() {
        let result = parse_args(&args(&[
            "--isolated",
            "tmux",
            "--isolated-user",
            "--",
            "npm",
            "test",
        ]))
        .unwrap();
        assert!(result.wrapper_options.user);
        assert_eq!(result.wrapper_options.isolated, Some("tmux".to_string()));
    }
}

mod status_tests {
    use super::*;

    #[test]
    fn should_error_for_status_with_flag_as_next_arg() {
        let result = parse_args(&args(&["--status", "--other-flag"]));
        assert!(result.is_err());
    }

    #[test]
    fn should_default_status_to_none() {
        let result = parse_args(&args(&["ls"])).unwrap();
        assert!(result.wrapper_options.status.is_none());
    }

    #[test]
    fn should_normalize_output_format_to_lowercase() {
        let result =
            parse_args(&args(&["--status", "uuid-here", "--output-format", "JSON"])).unwrap();
        assert_eq!(
            result.wrapper_options.output_format,
            Some("json".to_string())
        );
    }

    #[test]
    fn should_accept_all_valid_output_formats() {
        for fmt in &["links-notation", "json", "text"] {
            let result = parse_args(&args(&["--status", "uuid-here", "--output-format", fmt]));
            assert!(
                result.is_ok(),
                "Format '{}' should be valid: {:?}",
                fmt,
                result
            );
        }
    }

    #[test]
    fn should_default_output_format_to_none() {
        let result = parse_args(&args(&["ls"])).unwrap();
        assert!(result.wrapper_options.output_format.is_none());
    }
}

mod valid_output_formats_tests {
    use start_command::VALID_OUTPUT_FORMATS;

    #[test]
    fn should_include_links_notation() {
        assert!(VALID_OUTPUT_FORMATS.contains(&"links-notation"));
    }

    #[test]
    fn should_include_json() {
        assert!(VALID_OUTPUT_FORMATS.contains(&"json"));
    }

    #[test]
    fn should_include_text() {
        assert!(VALID_OUTPUT_FORMATS.contains(&"text"));
    }
}

mod cleanup_tests {
    use super::*;

    #[test]
    fn should_default_cleanup_to_false() {
        let result = parse_args(&args(&["ls"])).unwrap();
        assert!(!result.wrapper_options.cleanup);
        assert!(!result.wrapper_options.cleanup_dry_run);
    }
}
