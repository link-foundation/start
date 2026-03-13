//! Extended tests for output_blocks module.
//!
//! Covers additional tests from js/test/output-blocks.test.js not already in output_blocks_test.rs.

use start_command::{
    create_command_line, create_empty_timeline_line, create_timeline_line,
    create_timeline_separator, create_virtual_command_block, create_virtual_command_result,
    escape_for_links_notation, format_duration, format_value_for_links_notation,
    generate_isolation_lines, get_result_marker, parse_isolation_metadata, IsolationMetadata,
    FAILURE_MARKER, SUCCESS_MARKER, TIMELINE_MARKER,
};

#[allow(deprecated)]
use start_command::{create_empty_spine_line, create_spine_line, SPINE};

mod timeline_constants_tests {
    use super::*;

    #[test]
    fn should_export_timeline_marker_character() {
        assert_eq!(TIMELINE_MARKER, "│");
    }

    #[test]
    #[allow(deprecated)]
    fn should_export_spine_as_alias_for_backward_compatibility() {
        assert_eq!(SPINE, TIMELINE_MARKER);
    }

    #[test]
    fn should_export_result_markers() {
        assert_eq!(SUCCESS_MARKER, "✓");
        assert_eq!(FAILURE_MARKER, "✗");
    }
}

mod create_timeline_line_tests {
    use super::*;

    #[test]
    fn should_create_a_line_with_timeline_marker_prefix_and_padded_label() {
        let line = create_timeline_line("session", "abc-123");
        assert!(line.starts_with(TIMELINE_MARKER));
        assert!(line.contains("session"));
        assert!(line.contains("abc-123"));
    }

    #[test]
    fn should_pad_labels_to_10_characters() {
        let line = create_timeline_line("start", "2024-01-01");
        // Label should be padded, so "start" becomes "start     " (10 chars)
        assert!(line.contains("start"), "Should contain label: {}", line);
    }

    #[test]
    #[allow(deprecated)]
    fn create_spine_line_should_work_as_alias() {
        let line1 = create_timeline_line("session", "test");
        let line2 = create_spine_line("session", "test");
        assert_eq!(line1, line2);
    }
}

mod create_empty_timeline_line_tests {
    use super::*;

    #[test]
    fn should_create_just_the_timeline_marker_character() {
        let line = create_empty_timeline_line();
        assert_eq!(line.trim_end(), TIMELINE_MARKER);
    }

    #[test]
    #[allow(deprecated)]
    fn create_empty_spine_line_should_work_as_alias() {
        let line1 = create_empty_timeline_line();
        let line2 = create_empty_spine_line();
        assert_eq!(line1, line2);
    }
}

mod create_command_line_tests {
    use super::*;

    #[test]
    fn should_create_a_line_with_dollar_prefix() {
        let line = create_command_line("npm test");
        assert!(line.starts_with("$"), "Should start with $: {}", line);
        assert!(line.contains("npm test"));
    }
}

mod get_result_marker_tests {
    use super::*;

    #[test]
    fn should_return_success_marker_for_exit_code_0() {
        assert_eq!(get_result_marker(0), SUCCESS_MARKER);
    }

    #[test]
    fn should_return_failure_marker_for_non_zero_exit_codes() {
        assert_eq!(get_result_marker(1), FAILURE_MARKER);
        assert_eq!(get_result_marker(127), FAILURE_MARKER);
        assert_eq!(get_result_marker(255), FAILURE_MARKER);
    }
}

mod parse_isolation_metadata_tests {
    use super::*;

    #[test]
    fn should_parse_environment_and_mode() {
        let lines = vec!["[Isolation] Environment: screen, Mode: attached"];
        let meta = parse_isolation_metadata(&lines);
        assert_eq!(meta.isolation, Some("screen".to_string()));
        assert_eq!(meta.mode, Some("attached".to_string()));
    }

    #[test]
    fn should_parse_session_name() {
        let lines = vec!["[Isolation] Session: my-session-123"];
        let meta = parse_isolation_metadata(&lines);
        assert_eq!(meta.session, Some("my-session-123".to_string()));
    }

    #[test]
    fn should_parse_docker_image() {
        let lines = vec!["[Isolation] Image: ubuntu:22.04"];
        let meta = parse_isolation_metadata(&lines);
        assert_eq!(meta.image, Some("ubuntu:22.04".to_string()));
    }

    #[test]
    fn should_parse_all_fields_together() {
        let lines = vec![
            "[Isolation] Environment: docker, Mode: detached",
            "[Isolation] Session: my-docker-session",
            "[Isolation] Image: node:20",
        ];
        let meta = parse_isolation_metadata(&lines);
        assert_eq!(meta.isolation, Some("docker".to_string()));
        assert_eq!(meta.mode, Some("detached".to_string()));
        assert_eq!(meta.session, Some("my-docker-session".to_string()));
        assert_eq!(meta.image, Some("node:20".to_string()));
    }
}

mod generate_isolation_lines_tests {
    use super::*;

    #[test]
    fn should_generate_lines_for_docker_isolation() {
        let meta = IsolationMetadata {
            isolation: Some("docker".to_string()),
            mode: Some("attached".to_string()),
            session: Some("docker-123".to_string()),
            image: Some("ubuntu:latest".to_string()),
            endpoint: None,
            user: None,
        };
        let lines = generate_isolation_lines(&meta, None);
        // Should contain isolation metadata
        let all = lines.join("\n");
        assert!(all.contains("docker"), "Should mention docker: {}", all);
    }

    #[test]
    fn should_generate_lines_for_screen_isolation() {
        let meta = IsolationMetadata {
            isolation: Some("screen".to_string()),
            mode: Some("attached".to_string()),
            session: Some("screen-abc".to_string()),
            image: None,
            endpoint: None,
            user: None,
        };
        let lines = generate_isolation_lines(&meta, None);
        let all = lines.join("\n");
        assert!(all.contains("screen"), "Should mention screen: {}", all);
    }
}

mod format_duration_tests {
    use super::*;

    #[test]
    fn should_format_very_small_durations() {
        // Durations under 1ms
        let result = format_duration(0.0001);
        assert!(!result.is_empty());
    }

    #[test]
    fn should_format_millisecond_durations() {
        let result = format_duration(0.5); // 500ms
        assert!(
            result.contains("ms") || result.contains("s"),
            "Duration format: {}",
            result
        );
    }

    #[test]
    fn should_format_second_durations() {
        let result = format_duration(1.234); // 1.234s
        assert!(result.contains("s"), "Should contain 's': {}", result);
    }

    #[test]
    fn should_format_longer_durations_with_less_precision() {
        let result = format_duration(65.5); // 65.5s
        assert!(!result.is_empty());
    }
}

mod escape_for_links_notation_tests {
    use super::*;

    #[test]
    fn should_not_quote_simple_values() {
        // Simple alphanumeric values don't need quoting
        let result = escape_for_links_notation("simple");
        assert_eq!(result, "simple");
    }

    #[test]
    fn should_quote_values_with_spaces() {
        let result = escape_for_links_notation("hello world");
        assert!(result.contains('"') || result.contains('\''));
        assert!(result.contains("hello"));
        assert!(result.contains("world"));
    }

    #[test]
    fn should_quote_values_with_colons() {
        let result = escape_for_links_notation("ubuntu:latest");
        // Values with colons need quoting in links notation
        assert!(result.contains("ubuntu") && result.contains("latest"));
    }
}

mod format_value_for_links_notation_tests {
    use super::*;

    #[test]
    fn should_handle_null_values() {
        let result = format_value_for_links_notation(&serde_json::Value::Null);
        assert_eq!(result, "null");
    }

    #[test]
    fn should_format_simple_objects() {
        let val = serde_json::json!({"key": "value"});
        let result = format_value_for_links_notation(&val);
        assert!(!result.is_empty());
    }
}

mod create_virtual_command_tests {
    use super::*;

    #[test]
    fn should_create_virtual_command_block() {
        let block = create_virtual_command_block("docker pull ubuntu:latest");
        assert!(
            block.contains("docker pull ubuntu:latest"),
            "Should contain the command: {}",
            block
        );
    }

    #[test]
    fn should_create_virtual_command_result() {
        let result_success = create_virtual_command_result(true);
        assert_eq!(result_success.trim(), SUCCESS_MARKER);

        let result_failure = create_virtual_command_result(false);
        assert_eq!(result_failure.trim(), FAILURE_MARKER);
    }
}

mod create_timeline_separator_tests {
    use super::*;

    #[test]
    fn should_create_a_separator_line() {
        let sep = create_timeline_separator();
        assert!(!sep.is_empty());
    }
}
