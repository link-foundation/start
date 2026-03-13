//! Sequence Parser for Isolation Stacking
//!
//! Parses space-separated sequences with underscore placeholders for
//! distributing options across isolation levels.
//!
//! Based on Links Notation conventions and mirrors the JavaScript implementation
//! in js/src/lib/sequence-parser.js.

/// Parse a space-separated sequence with underscore placeholders.
///
/// Returns a Vec of Option<String>, with None for underscore placeholders.
///
/// # Examples
///
/// ```
/// use start_command::sequence_parser::parse_sequence;
/// assert_eq!(parse_sequence("docker"), vec![Some("docker".to_string())]);
/// assert_eq!(parse_sequence("screen ssh docker"), vec![
///     Some("screen".to_string()),
///     Some("ssh".to_string()),
///     Some("docker".to_string()),
/// ]);
/// assert_eq!(parse_sequence("_ ssh _"), vec![None, Some("ssh".to_string()), None]);
/// ```
pub fn parse_sequence(value: &str) -> Vec<Option<String>> {
    // split_whitespace handles leading/trailing whitespace and returns empty iter for empty/whitespace-only strings
    let parts: Vec<Option<String>> = value
        .split_whitespace()
        .map(|v| if v == "_" { None } else { Some(v.to_string()) })
        .collect();
    parts
}

/// Format a sequence array back to a space-separated string.
///
/// None values are represented as underscores.
///
/// # Examples
///
/// ```
/// use start_command::sequence_parser::format_sequence;
/// assert_eq!(format_sequence(&[Some("screen".to_string()), None, Some("docker".to_string())]),
///     "screen _ docker");
/// assert_eq!(format_sequence(&[]), "");
/// ```
pub fn format_sequence(sequence: &[Option<String>]) -> String {
    if sequence.is_empty() {
        return String::new();
    }
    sequence
        .iter()
        .map(|v| v.as_deref().unwrap_or("_"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Shift a sequence by removing the first element.
///
/// # Examples
///
/// ```
/// use start_command::sequence_parser::shift_sequence;
/// let seq = vec![Some("screen".to_string()), Some("ssh".to_string())];
/// assert_eq!(shift_sequence(&seq), vec![Some("ssh".to_string())]);
/// ```
pub fn shift_sequence(sequence: &[Option<String>]) -> Vec<Option<String>> {
    if sequence.is_empty() {
        return vec![];
    }
    sequence[1..].to_vec()
}

/// Check if a string represents a multi-value sequence (contains spaces).
///
/// # Examples
///
/// ```
/// use start_command::sequence_parser::is_sequence;
/// assert!(is_sequence("screen ssh docker"));
/// assert!(!is_sequence("docker"));
/// assert!(!is_sequence(""));
/// ```
pub fn is_sequence(value: &str) -> bool {
    value.contains(' ')
}

/// Distribute a single option value across all isolation levels.
///
/// If the value is a sequence, validates length matches stack depth.
/// If the value is a single value, replicates it for all levels.
///
/// Returns an error string if sequence length doesn't match stack depth.
///
/// # Examples
///
/// ```
/// use start_command::sequence_parser::distribute_option;
/// // Single value replicated
/// assert_eq!(distribute_option("node:20", 3, "image"), Ok(vec![
///     Some("node:20".to_string()),
///     Some("node:20".to_string()),
///     Some("node:20".to_string()),
/// ]));
/// // Sequence distributed
/// assert_eq!(distribute_option("_ user@host _", 3, "endpoint"), Ok(vec![
///     None, Some("user@host".to_string()), None,
/// ]));
/// ```
pub fn distribute_option(
    option_value: &str,
    stack_depth: usize,
    option_name: &str,
) -> Result<Vec<Option<String>>, String> {
    if option_value.is_empty() {
        return Ok(vec![None; stack_depth]);
    }

    let parsed = parse_sequence(option_value);

    // Single value: replicate for all levels
    if parsed.len() == 1 && stack_depth > 1 {
        return Ok(vec![parsed[0].clone(); stack_depth]);
    }

    // Sequence: validate length matches
    if parsed.len() != stack_depth {
        return Err(format!(
            "{} has {} value(s) but isolation stack has {} level(s). \
             Use underscores (_) as placeholders for levels that don't need this option.",
            option_name,
            parsed.len(),
            stack_depth
        ));
    }

    Ok(parsed)
}

/// Get the value at a specific level from a distributed option.
///
/// Returns None if the index is out of bounds or the value at that level is None.
pub fn get_value_at_level(distributed: &[Option<String>], level: usize) -> Option<&str> {
    distributed.get(level)?.as_deref()
}

/// Format isolation chain for display.
///
/// Returns a human-readable description like "screen → ssh@host → docker:ubuntu".
///
/// # Examples
///
/// ```
/// use start_command::sequence_parser::{format_isolation_chain, IsolationChainOptions};
/// let stack = vec![Some("screen".to_string()), Some("docker".to_string())];
/// let opts = IsolationChainOptions::default();
/// assert_eq!(format_isolation_chain(&stack, &opts), "screen → docker");
/// ```
pub fn format_isolation_chain(stack: &[Option<String>], options: &IsolationChainOptions) -> String {
    if stack.is_empty() {
        return String::new();
    }
    stack
        .iter()
        .enumerate()
        .map(|(i, backend)| match backend.as_deref() {
            None => "_".to_string(),
            Some("ssh") => {
                if let Some(ep) = get_value_at_level(&options.endpoint_stack, i) {
                    format!("ssh@{}", ep)
                } else {
                    "ssh".to_string()
                }
            }
            Some("docker") => {
                if let Some(image) = get_value_at_level(&options.image_stack, i) {
                    let short_name = image.split(':').next().unwrap_or(image);
                    let short_name = short_name.rsplit('/').next().unwrap_or(short_name);
                    format!("docker:{}", short_name)
                } else {
                    "docker".to_string()
                }
            }
            Some(b) => b.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" \u{2192} ")
}

/// Options for format_isolation_chain
#[derive(Default)]
pub struct IsolationChainOptions {
    /// Distributed endpoints for SSH levels
    pub endpoint_stack: Vec<Option<String>>,
    /// Distributed images for Docker levels
    pub image_stack: Vec<Option<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_sequence_single() {
        assert_eq!(parse_sequence("docker"), vec![Some("docker".to_string())]);
    }

    #[test]
    fn test_parse_sequence_multiple() {
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
    fn test_parse_sequence_with_underscores() {
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
    fn test_parse_sequence_all_underscores() {
        assert_eq!(parse_sequence("_ _ _"), vec![None, None, None]);
    }

    #[test]
    fn test_parse_sequence_empty_string() {
        assert_eq!(parse_sequence(""), vec![]);
    }

    #[test]
    fn test_parse_sequence_trims_whitespace() {
        assert_eq!(
            parse_sequence("  docker  "),
            vec![Some("docker".to_string())]
        );
    }

    #[test]
    fn test_parse_sequence_multiple_spaces() {
        assert_eq!(
            parse_sequence("screen  ssh"),
            vec![Some("screen".to_string()), Some("ssh".to_string())]
        );
    }

    #[test]
    fn test_format_sequence_with_values() {
        let seq = vec![
            Some("screen".to_string()),
            Some("ssh".to_string()),
            Some("docker".to_string()),
        ];
        assert_eq!(format_sequence(&seq), "screen ssh docker");
    }

    #[test]
    fn test_format_sequence_with_nulls() {
        let seq = vec![None, Some("ssh".to_string()), None];
        assert_eq!(format_sequence(&seq), "_ ssh _");
    }

    #[test]
    fn test_format_sequence_empty() {
        assert_eq!(format_sequence(&[]), "");
    }

    #[test]
    fn test_shift_sequence_removes_first() {
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
    fn test_shift_sequence_with_nulls() {
        let seq = vec![None, Some("ssh".to_string())];
        assert_eq!(shift_sequence(&seq), vec![Some("ssh".to_string())]);
    }

    #[test]
    fn test_shift_sequence_single_element() {
        let seq = vec![Some("docker".to_string())];
        assert_eq!(shift_sequence(&seq), vec![]);
    }

    #[test]
    fn test_shift_sequence_empty() {
        assert_eq!(shift_sequence(&[]), vec![]);
    }

    #[test]
    fn test_is_sequence_true_for_space_separated() {
        assert!(is_sequence("screen ssh docker"));
        assert!(is_sequence("_ ssh _"));
    }

    #[test]
    fn test_is_sequence_false_for_single_value() {
        assert!(!is_sequence("docker"));
        assert!(!is_sequence("screen"));
    }

    #[test]
    fn test_is_sequence_false_for_empty() {
        assert!(!is_sequence(""));
    }

    #[test]
    fn test_distribute_option_single_value_replicates() {
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
    fn test_distribute_option_sequence_with_matching_length() {
        let result = distribute_option("_ user@host _", 3, "endpoint").unwrap();
        assert_eq!(result, vec![None, Some("user@host".to_string()), None]);
    }

    #[test]
    fn test_distribute_option_throws_on_length_mismatch() {
        let result = distribute_option("_ user@host", 3, "endpoint");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("endpoint"));
    }

    #[test]
    fn test_distribute_option_empty_returns_nulls() {
        let result = distribute_option("", 3, "endpoint").unwrap();
        assert_eq!(result, vec![None, None, None]);
    }

    #[test]
    fn test_get_value_at_level_valid_index() {
        let dist = vec![Some("screen".to_string()), None, Some("docker".to_string())];
        assert_eq!(get_value_at_level(&dist, 0), Some("screen"));
        assert_eq!(get_value_at_level(&dist, 2), Some("docker"));
    }

    #[test]
    fn test_get_value_at_level_null_value() {
        let dist = vec![None, Some("ssh".to_string())];
        assert_eq!(get_value_at_level(&dist, 0), None);
    }

    #[test]
    fn test_get_value_at_level_out_of_bounds() {
        let dist = vec![Some("docker".to_string())];
        assert_eq!(get_value_at_level(&dist, 5), None);
    }

    #[test]
    fn test_format_isolation_chain_simple() {
        let stack = vec![Some("screen".to_string()), Some("docker".to_string())];
        let opts = IsolationChainOptions::default();
        assert_eq!(
            format_isolation_chain(&stack, &opts),
            "screen \u{2192} docker"
        );
    }

    #[test]
    fn test_format_isolation_chain_with_ssh_endpoint() {
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
    fn test_format_isolation_chain_with_docker_image_short_name() {
        let stack = vec![Some("docker".to_string())];
        let opts = IsolationChainOptions {
            image_stack: vec![Some("myregistry.io/team/ubuntu:22.04".to_string())],
            endpoint_stack: vec![],
        };
        assert_eq!(format_isolation_chain(&stack, &opts), "docker:ubuntu");
    }

    #[test]
    fn test_format_isolation_chain_with_placeholders() {
        let stack = vec![None, Some("ssh".to_string()), None];
        let opts = IsolationChainOptions::default();
        assert_eq!(
            format_isolation_chain(&stack, &opts),
            "_ \u{2192} ssh \u{2192} _"
        );
    }

    #[test]
    fn test_format_isolation_chain_empty() {
        let opts = IsolationChainOptions::default();
        assert_eq!(format_isolation_chain(&[], &opts), "");
    }
}
