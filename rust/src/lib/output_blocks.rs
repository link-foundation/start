//! Output formatting utilities for nicely rendered command blocks
//!
//! Provides "timeline" format: a width-independent, lossless output format
//! that works in TTY, tmux, SSH, CI, and logs.
//!
//! Core concepts:
//! - `│` prefix → tool metadata (timeline marker)
//! - `$` → executed command (virtual or user command)
//! - No prefix → program output (stdout/stderr)
//! - Result marker (`✓` / `✗`) appears after output

use regex::Regex;

/// Timeline marker character (formerly called "spine")
/// Used to prefix metadata lines in the timeline format
pub const TIMELINE_MARKER: &str = "│";

/// Alias for backward compatibility
#[deprecated(since = "0.20.0", note = "Use TIMELINE_MARKER instead")]
pub const SPINE: &str = "│";

/// Success result marker
pub const SUCCESS_MARKER: &str = "✓";

/// Failure result marker
pub const FAILURE_MARKER: &str = "✗";

/// Create a metadata line with timeline marker prefix
pub fn create_timeline_line(label: &str, value: &str) -> String {
    // Pad label to 10 characters for alignment
    format!("{} {:10}{}", TIMELINE_MARKER, label, value)
}

/// Alias for backward compatibility
#[deprecated(since = "0.20.0", note = "Use create_timeline_line instead")]
pub fn create_spine_line(label: &str, value: &str) -> String {
    create_timeline_line(label, value)
}

/// Create an empty timeline line (just the timeline marker character)
pub fn create_empty_timeline_line() -> String {
    TIMELINE_MARKER.to_string()
}

/// Alias for backward compatibility
#[deprecated(since = "0.20.0", note = "Use create_empty_timeline_line instead")]
pub fn create_empty_spine_line() -> String {
    create_empty_timeline_line()
}

/// Create a command line with $ prefix
pub fn create_command_line(command: &str) -> String {
    format!("$ {}", command)
}

/// Create a virtual command block for setup steps (like docker pull)
/// Virtual commands are displayed separately in the timeline to show
/// intermediate steps that the tool performs automatically
pub fn create_virtual_command_block(command: &str) -> String {
    create_command_line(command)
}

/// Create a result marker line for a virtual command
pub fn create_virtual_command_result(success: bool) -> String {
    if success {
        SUCCESS_MARKER.to_string()
    } else {
        FAILURE_MARKER.to_string()
    }
}

/// Create a separator line between virtual commands and user commands
pub fn create_timeline_separator() -> String {
    create_empty_timeline_line()
}

/// Get the result marker based on exit code
pub fn get_result_marker(exit_code: i32) -> &'static str {
    if exit_code == 0 {
        SUCCESS_MARKER
    } else {
        FAILURE_MARKER
    }
}

/// Parsed isolation metadata
#[derive(Default)]
pub struct IsolationMetadata {
    pub isolation: Option<String>,
    pub mode: Option<String>,
    pub image: Option<String>,
    pub session: Option<String>,
    pub endpoint: Option<String>,
    pub user: Option<String>,
}

/// Parse isolation metadata from extra lines
pub fn parse_isolation_metadata(extra_lines: &[&str]) -> IsolationMetadata {
    let mut metadata = IsolationMetadata::default();

    let env_mode_re = Regex::new(r"\[Isolation\] Environment: (\w+), Mode: (\w+)").unwrap();
    let session_re = Regex::new(r"\[Isolation\] Session: (.+)").unwrap();
    let image_re = Regex::new(r"\[Isolation\] Image: (.+)").unwrap();
    let endpoint_re = Regex::new(r"\[Isolation\] Endpoint: (.+)").unwrap();
    let user_re = Regex::new(r"\[Isolation\] User: (\w+)").unwrap();

    for line in extra_lines {
        if let Some(caps) = env_mode_re.captures(line) {
            metadata.isolation = Some(caps[1].to_string());
            metadata.mode = Some(caps[2].to_string());
            continue;
        }

        if let Some(caps) = session_re.captures(line) {
            metadata.session = Some(caps[1].to_string());
            continue;
        }

        if let Some(caps) = image_re.captures(line) {
            metadata.image = Some(caps[1].to_string());
            continue;
        }

        if let Some(caps) = endpoint_re.captures(line) {
            metadata.endpoint = Some(caps[1].to_string());
            continue;
        }

        if let Some(caps) = user_re.captures(line) {
            metadata.user = Some(caps[1].to_string());
        }
    }

    metadata
}

/// Generate isolation metadata lines for timeline format
pub fn generate_isolation_lines(
    metadata: &IsolationMetadata,
    container_or_screen_name: Option<&str>,
) -> Vec<String> {
    let mut lines = Vec::new();

    if let Some(ref isolation) = metadata.isolation {
        lines.push(create_timeline_line("isolation", isolation));
    }

    if let Some(ref mode) = metadata.mode {
        lines.push(create_timeline_line("mode", mode));
    }

    if let Some(ref image) = metadata.image {
        lines.push(create_timeline_line("image", image));
    }

    // Use provided container/screen name or fall back to metadata.session
    if let Some(ref isolation) = metadata.isolation {
        let name = container_or_screen_name
            .map(String::from)
            .or_else(|| metadata.session.clone());

        if let Some(name) = name {
            match isolation.as_str() {
                "docker" => lines.push(create_timeline_line("container", &name)),
                "screen" => lines.push(create_timeline_line("screen", &name)),
                "tmux" => lines.push(create_timeline_line("tmux", &name)),
                "ssh" => {
                    if let Some(ref endpoint) = metadata.endpoint {
                        lines.push(create_timeline_line("endpoint", endpoint));
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(ref user) = metadata.user {
        lines.push(create_timeline_line("user", user));
    }

    lines
}

/// Options for creating a start block
pub struct StartBlockOptions<'a> {
    pub session_id: &'a str,
    pub timestamp: &'a str,
    pub command: &'a str,
    pub extra_lines: Option<Vec<&'a str>>,
    pub style: Option<&'a str>,
    pub width: Option<usize>,
    /// If true, the command line is omitted from the start block
    /// (useful when virtual commands will be shown before the actual command)
    pub defer_command: bool,
}

/// Create a start block for command execution using timeline format
pub fn create_start_block(options: &StartBlockOptions) -> String {
    let mut lines = Vec::new();

    // Header: session and start time
    lines.push(create_timeline_line("session", options.session_id));
    lines.push(create_timeline_line("start", options.timestamp));

    // Parse and add isolation metadata if present
    if let Some(ref extra) = options.extra_lines {
        let metadata = parse_isolation_metadata(extra);

        if metadata.isolation.is_some() {
            lines.push(create_empty_timeline_line());
            lines.extend(generate_isolation_lines(&metadata, None));
        }
    }

    // Empty timeline line before command (always needed for separation)
    lines.push(create_empty_timeline_line());

    // Command line (unless deferred for virtual command handling)
    if !options.defer_command {
        lines.push(create_command_line(options.command));
    }

    lines.join("\n")
}

/// Format duration in seconds with appropriate precision
pub fn format_duration(duration_ms: f64) -> String {
    let seconds = duration_ms / 1000.0;
    if seconds < 0.001 {
        "0.001s".to_string()
    } else if seconds < 10.0 {
        // For durations under 10 seconds, show 3 decimal places
        format!("{:.3}s", seconds)
    } else if seconds < 100.0 {
        format!("{:.2}s", seconds)
    } else {
        format!("{:.1}s", seconds)
    }
}

/// Options for creating a finish block
pub struct FinishBlockOptions<'a> {
    pub session_id: &'a str,
    pub timestamp: &'a str,
    pub exit_code: i32,
    pub log_path: &'a str,
    pub duration_ms: Option<f64>,
    pub result_message: Option<&'a str>,
    pub extra_lines: Option<Vec<&'a str>>,
    pub style: Option<&'a str>,
    pub width: Option<usize>,
}

/// Create a finish block for command execution using timeline format
///
/// Bottom block ordering rules:
/// 1. Result marker (✓ or ✗)
/// 2. finish timestamp
/// 3. duration
/// 4. exit code
/// 5. (repeated isolation metadata, if any)
/// 6. empty timeline line
/// 7. log path (always second-to-last)
/// 8. session ID (always last)
pub fn create_finish_block(options: &FinishBlockOptions) -> String {
    let mut lines = Vec::new();

    // Result marker appears first in footer (after program output)
    lines.push(get_result_marker(options.exit_code).to_string());

    // Finish metadata
    lines.push(create_timeline_line("finish", options.timestamp));

    if let Some(duration_ms) = options.duration_ms {
        lines.push(create_timeline_line(
            "duration",
            &format_duration(duration_ms),
        ));
    }

    lines.push(create_timeline_line("exit", &options.exit_code.to_string()));

    // Repeat isolation metadata if present
    if let Some(ref extra) = options.extra_lines {
        let metadata = parse_isolation_metadata(extra);
        if metadata.isolation.is_some() {
            lines.push(create_empty_timeline_line());
            lines.extend(generate_isolation_lines(&metadata, None));
        }
    }

    // Empty timeline line before final two entries
    lines.push(create_empty_timeline_line());

    // Log and session are ALWAYS last (in that order)
    lines.push(create_timeline_line("log", options.log_path));
    lines.push(create_timeline_line("session", options.session_id));

    lines.join("\n")
}

/// Escape a value for Links notation
/// Smart quoting: uses single or double quotes based on content
pub fn escape_for_links_notation(value: &str) -> String {
    let has_colon = value.contains(':');
    let has_double_quotes = value.contains('"');
    let has_single_quotes = value.contains('\'');
    let has_parens = value.contains('(') || value.contains(')');
    let has_newline = value.contains('\n');
    let has_space = value.contains(' ');

    let needs_quoting = has_colon
        || has_double_quotes
        || has_single_quotes
        || has_parens
        || has_newline
        || has_space;

    if !needs_quoting {
        return value.to_string();
    }

    if has_double_quotes && !has_single_quotes {
        // Has " but not ' → use single quotes
        format!("'{}'", value)
    } else if has_single_quotes && !has_double_quotes {
        // Has ' but not " → use double quotes
        format!("\"{}\"", value)
    } else if has_double_quotes && has_single_quotes {
        // Has both " and ' → choose wrapper with fewer escapes
        let double_quote_count = value.matches('"').count();
        let single_quote_count = value.matches('\'').count();

        if single_quote_count <= double_quote_count {
            // Escape single quotes by doubling them
            let escaped = value.replace('\'', "''");
            format!("'{}'", escaped)
        } else {
            // Escape double quotes by doubling them
            let escaped = value.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        }
    } else {
        // Has colon, parentheses, newlines, or spaces but no quotes
        format!("\"{}\"", value)
    }
}

/// Format a serde_json::Value for Links notation
pub fn format_value_for_links_notation(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => escape_for_links_notation(s),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            // For complex types, serialize and quote
            let s = serde_json::to_string(value).unwrap_or_default();
            escape_for_links_notation(&s)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_timeline_line() {
        let line = create_timeline_line("session", "abc123");
        assert!(line.starts_with("│"));
        assert!(line.contains("session"));
        assert!(line.contains("abc123"));
    }

    #[test]
    fn test_create_command_line() {
        let line = create_command_line("echo hello");
        assert_eq!(line, "$ echo hello");
    }

    #[test]
    fn test_parse_isolation_metadata_screen() {
        let extra_lines = vec![
            "[Isolation] Environment: screen, Mode: attached",
            "[Isolation] Session: screen-1234567890-abc123",
        ];
        let metadata = parse_isolation_metadata(&extra_lines);
        assert_eq!(metadata.isolation, Some("screen".to_string()));
        assert_eq!(metadata.mode, Some("attached".to_string()));
        assert_eq!(
            metadata.session,
            Some("screen-1234567890-abc123".to_string())
        );
    }

    #[test]
    fn test_parse_isolation_metadata_tmux() {
        let extra_lines = vec![
            "[Isolation] Environment: tmux, Mode: detached",
            "[Isolation] Session: tmux-1234567890-xyz789",
        ];
        let metadata = parse_isolation_metadata(&extra_lines);
        assert_eq!(metadata.isolation, Some("tmux".to_string()));
        assert_eq!(metadata.mode, Some("detached".to_string()));
        assert_eq!(metadata.session, Some("tmux-1234567890-xyz789".to_string()));
    }

    #[test]
    fn test_parse_isolation_metadata_docker() {
        let extra_lines = vec![
            "[Isolation] Environment: docker, Mode: attached",
            "[Isolation] Session: docker-1234567890-def456",
            "[Isolation] Image: alpine:latest",
        ];
        let metadata = parse_isolation_metadata(&extra_lines);
        assert_eq!(metadata.isolation, Some("docker".to_string()));
        assert_eq!(metadata.mode, Some("attached".to_string()));
        assert_eq!(
            metadata.session,
            Some("docker-1234567890-def456".to_string())
        );
        assert_eq!(metadata.image, Some("alpine:latest".to_string()));
    }

    #[test]
    fn test_generate_isolation_lines_screen() {
        let metadata = IsolationMetadata {
            isolation: Some("screen".to_string()),
            mode: Some("attached".to_string()),
            session: Some("screen-1234567890-abc123".to_string()),
            ..Default::default()
        };
        let lines = generate_isolation_lines(&metadata, None);
        assert!(lines
            .iter()
            .any(|l| l.contains("isolation") && l.contains("screen")));
        assert!(lines
            .iter()
            .any(|l| l.contains("mode") && l.contains("attached")));
        // Issue #67: Session name should be displayed for screen
        assert!(
            lines
                .iter()
                .any(|l| l.contains("screen") && l.contains("screen-1234567890-abc123")),
            "Should display screen session name for reconnection (issue #67)"
        );
    }

    #[test]
    fn test_generate_isolation_lines_tmux() {
        let metadata = IsolationMetadata {
            isolation: Some("tmux".to_string()),
            mode: Some("detached".to_string()),
            session: Some("tmux-1234567890-xyz789".to_string()),
            ..Default::default()
        };
        let lines = generate_isolation_lines(&metadata, None);
        assert!(lines
            .iter()
            .any(|l| l.contains("isolation") && l.contains("tmux")));
        assert!(lines
            .iter()
            .any(|l| l.contains("mode") && l.contains("detached")));
        // Issue #67: Session name should be displayed for tmux
        assert!(
            lines
                .iter()
                .any(|l| l.contains("tmux") && l.contains("tmux-1234567890-xyz789")),
            "Should display tmux session name for reconnection (issue #67)"
        );
    }

    #[test]
    fn test_generate_isolation_lines_docker() {
        let metadata = IsolationMetadata {
            isolation: Some("docker".to_string()),
            mode: Some("attached".to_string()),
            session: Some("docker-1234567890-def456".to_string()),
            image: Some("alpine:latest".to_string()),
            ..Default::default()
        };
        let lines = generate_isolation_lines(&metadata, None);
        assert!(lines
            .iter()
            .any(|l| l.contains("isolation") && l.contains("docker")));
        assert!(lines
            .iter()
            .any(|l| l.contains("mode") && l.contains("attached")));
        assert!(lines
            .iter()
            .any(|l| l.contains("image") && l.contains("alpine:latest")));
        // Issue #67: Container name should be displayed for docker
        assert!(
            lines
                .iter()
                .any(|l| l.contains("container") && l.contains("docker-1234567890-def456")),
            "Should display docker container name for reconnection (issue #67)"
        );
    }

    #[test]
    fn test_create_start_block_with_isolation() {
        let extra_lines: Vec<&str> = vec![
            "[Isolation] Environment: screen, Mode: attached",
            "[Isolation] Session: screen-1234567890-test",
        ];
        let block = create_start_block(&StartBlockOptions {
            session_id: "uuid-123",
            timestamp: "2026-01-08 12:00:00",
            command: "echo hello",
            extra_lines: Some(extra_lines),
            style: None,
            width: None,
            defer_command: false,
        });
        // Issue #67: The start block should include the session name for reconnection
        assert!(block.contains("│ session   uuid-123"));
        assert!(block.contains("│ isolation screen"));
        assert!(
            block.contains("│ screen    screen-1234567890-test"),
            "Start block should display screen session name for reconnection (issue #67)"
        );
    }

    #[test]
    fn test_create_finish_block_with_isolation() {
        let extra_lines: Vec<&str> = vec![
            "[Isolation] Environment: docker, Mode: attached",
            "[Isolation] Session: docker-1234567890-test",
            "[Isolation] Image: alpine:latest",
        ];
        let block = create_finish_block(&FinishBlockOptions {
            session_id: "uuid-456",
            timestamp: "2026-01-08 12:00:01",
            exit_code: 0,
            log_path: "/tmp/test.log",
            duration_ms: Some(100.0),
            result_message: None,
            extra_lines: Some(extra_lines),
            style: None,
            width: None,
        });
        // Issue #67: The finish block should include the container name for reconnection
        assert!(block.contains("✓"));
        assert!(block.contains("│ session   uuid-456"));
        assert!(
            block.contains("│ container docker-1234567890-test"),
            "Finish block should display docker container name for reconnection (issue #67)"
        );
    }

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(500.0), "0.500s");
        assert_eq!(format_duration(1500.0), "1.500s");
        assert_eq!(format_duration(15000.0), "15.00s");
        assert_eq!(format_duration(150000.0), "150.0s");
    }

    #[test]
    fn test_escape_for_links_notation() {
        // Simple value - no quoting needed
        assert_eq!(escape_for_links_notation("simple"), "simple");
        // Value with space - needs quoting
        assert_eq!(escape_for_links_notation("hello world"), "\"hello world\"");
        // Value with colon - needs quoting
        assert_eq!(escape_for_links_notation("key:value"), "\"key:value\"");
    }
}
