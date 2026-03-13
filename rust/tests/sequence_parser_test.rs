//! Tests for sequence_parser module.
//!
//! Tests for isolation stacking feature (issue #77).
//! Mirrors js/test/sequence-parser.test.js

use start_command::sequence_parser::{
    distribute_option, format_isolation_chain, format_sequence, get_value_at_level, is_sequence,
    parse_sequence, shift_sequence, IsolationChainOptions,
};

mod parse_sequence_tests {
    use super::*;

    #[test]
    fn should_parse_single_value() {
        assert_eq!(parse_sequence("docker"), vec![Some("docker".to_string())]);
    }

    #[test]
    fn should_parse_space_separated_sequence() {
        assert_eq!(
            parse_sequence("screen ssh docker"),
            vec![
                Some("screen".to_string()),
                Some("ssh".to_string()),
                Some("docker".to_string()),
            ]
        );
    }

    #[test]
    fn should_parse_sequence_with_underscores_as_null() {
        assert_eq!(
            parse_sequence("_ ssh _ docker"),
            vec![
                None,
                Some("ssh".to_string()),
                None,
                Some("docker".to_string()),
            ]
        );
    }

    #[test]
    fn should_handle_all_underscores() {
        assert_eq!(parse_sequence("_ _ _"), vec![None, None, None]);
    }

    #[test]
    fn should_handle_empty_string() {
        assert_eq!(parse_sequence(""), vec![]);
    }

    #[test]
    fn should_trim_whitespace() {
        assert_eq!(
            parse_sequence("  docker  "),
            vec![Some("docker".to_string())]
        );
    }

    #[test]
    fn should_handle_multiple_spaces_between_values() {
        assert_eq!(
            parse_sequence("screen  ssh"),
            vec![Some("screen".to_string()), Some("ssh".to_string())]
        );
    }
}

mod format_sequence_tests {
    use super::*;

    #[test]
    fn should_format_array_with_values() {
        let seq = vec![
            Some("screen".to_string()),
            Some("ssh".to_string()),
            Some("docker".to_string()),
        ];
        assert_eq!(format_sequence(&seq), "screen ssh docker");
    }

    #[test]
    fn should_format_array_with_nulls_as_underscores() {
        let seq = vec![None, Some("ssh".to_string()), None];
        assert_eq!(format_sequence(&seq), "_ ssh _");
    }

    #[test]
    fn should_handle_empty_array() {
        assert_eq!(format_sequence(&[]), "");
    }
}

mod shift_sequence_tests {
    use super::*;

    #[test]
    fn should_remove_first_element() {
        let seq = vec![
            Some("screen".to_string()),
            Some("ssh".to_string()),
            Some("docker".to_string()),
        ];
        assert_eq!(
            shift_sequence(&seq),
            vec![Some("ssh".to_string()), Some("docker".to_string())]
        );
    }

    #[test]
    fn should_handle_nulls() {
        let seq = vec![None, Some("ssh".to_string())];
        assert_eq!(shift_sequence(&seq), vec![Some("ssh".to_string())]);
    }

    #[test]
    fn should_handle_single_element() {
        let seq = vec![Some("docker".to_string())];
        assert_eq!(shift_sequence(&seq), vec![]);
    }

    #[test]
    fn should_handle_empty_array() {
        assert_eq!(shift_sequence(&[]), vec![]);
    }
}

mod is_sequence_tests {
    use super::*;

    #[test]
    fn should_return_true_for_space_separated_values() {
        assert!(is_sequence("screen ssh docker"));
    }

    #[test]
    fn should_return_false_for_single_value() {
        assert!(!is_sequence("docker"));
    }

    #[test]
    fn should_return_false_for_empty_string() {
        assert!(!is_sequence(""));
    }
}

mod distribute_option_tests {
    use super::*;

    #[test]
    fn should_replicate_single_value_for_all_levels() {
        let result = distribute_option("node:20", 3, "image").unwrap();
        assert_eq!(
            result,
            vec![
                Some("node:20".to_string()),
                Some("node:20".to_string()),
                Some("node:20".to_string()),
            ]
        );
    }

    #[test]
    fn should_parse_sequence_with_matching_length() {
        let result = distribute_option("_ user@host _", 3, "endpoint").unwrap();
        assert_eq!(result, vec![None, Some("user@host".to_string()), None]);
    }

    #[test]
    fn should_err_on_length_mismatch() {
        let result = distribute_option("_ user@host", 3, "endpoint");
        assert!(result.is_err());
    }

    #[test]
    fn should_handle_empty_value() {
        let result = distribute_option("", 3, "endpoint").unwrap();
        assert_eq!(result, vec![None, None, None]);
    }
}

mod get_value_at_level_tests {
    use super::*;

    #[test]
    fn should_get_value_at_valid_index() {
        let dist = vec![Some("screen".to_string()), None, Some("docker".to_string())];
        assert_eq!(get_value_at_level(&dist, 0), Some("screen"));
        assert_eq!(get_value_at_level(&dist, 2), Some("docker"));
    }

    #[test]
    fn should_handle_null_value() {
        let dist = vec![None, Some("ssh".to_string())];
        assert_eq!(get_value_at_level(&dist, 0), None);
    }

    #[test]
    fn should_return_none_for_out_of_bounds() {
        let dist = vec![Some("docker".to_string())];
        assert_eq!(get_value_at_level(&dist, 5), None);
    }
}

mod format_isolation_chain_tests {
    use super::*;

    #[test]
    fn should_format_simple_chain() {
        let stack = vec![Some("screen".to_string()), Some("docker".to_string())];
        let opts = IsolationChainOptions::default();
        assert_eq!(
            format_isolation_chain(&stack, &opts),
            "screen \u{2192} docker"
        );
    }

    #[test]
    fn should_add_ssh_endpoint() {
        let stack = vec![Some("screen".to_string()), Some("ssh".to_string())];
        let opts = IsolationChainOptions {
            endpoint_stack: vec![None, Some("user@host.com".to_string())],
            image_stack: vec![],
        };
        assert_eq!(
            format_isolation_chain(&stack, &opts),
            "screen \u{2192} ssh@user@host.com"
        );
    }

    #[test]
    fn should_add_docker_image_short_name() {
        let stack = vec![Some("docker".to_string())];
        let opts = IsolationChainOptions {
            image_stack: vec![Some("myregistry.io/team/ubuntu:22.04".to_string())],
            endpoint_stack: vec![],
        };
        assert_eq!(format_isolation_chain(&stack, &opts), "docker:ubuntu");
    }

    #[test]
    fn should_handle_placeholders() {
        let stack = vec![None, Some("ssh".to_string()), None];
        let opts = IsolationChainOptions::default();
        assert_eq!(
            format_isolation_chain(&stack, &opts),
            "_ \u{2192} ssh \u{2192} _"
        );
    }

    #[test]
    fn should_handle_empty_array() {
        let opts = IsolationChainOptions::default();
        assert_eq!(format_isolation_chain(&[], &opts), "");
    }
}
