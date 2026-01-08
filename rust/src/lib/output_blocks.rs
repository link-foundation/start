//! Output formatting utilities for nicely rendered command blocks
//!
//! Provides "status spine" format: a width-independent, lossless output format
//! that works in TTY, tmux, SSH, CI, and logs.
//!
//! Core concepts:
//! - `│` prefix → tool metadata
//! - `$` → executed command
//! - No prefix → program output (stdout/stderr)
//! - Result marker (`✓` / `✗`) appears after output

use regex::Regex;

/// Metadata spine character
pub const SPINE: &str = "│";

/// Success result marker
pub const SUCCESS_MARKER: &str = "✓";

/// Failure result marker
pub const FAILURE_MARKER: &str = "✗";

/// Create a metadata line with spine prefix
pub fn create_spine_line(label: &str, value: &str) -> String {
    // Pad label to 10 characters for alignment
    format!("{} {:10}{}", SPINE, label, value)
}

/// Create an empty spine line (just the spine character)
pub fn create_empty_spine_line() -> String {
    SPINE.to_string()
}

/// Create a command line with $ prefix
pub fn create_command_line(command: &str) -> String {
    format!("$ {}", command)
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

/// Generate isolation metadata lines for spine format
pub fn generate_isolation_lines(
    metadata: &IsolationMetadata,
    container_or_screen_name: Option<&str>,
) -> Vec<String> {
    let mut lines = Vec::new();

    if let Some(ref isolation) = metadata.isolation {
        lines.push(create_spine_line("isolation", isolation));
    }

    if let Some(ref mode) = metadata.mode {
        lines.push(create_spine_line("mode", mode));
    }

    if let Some(ref image) = metadata.image {
        lines.push(create_spine_line("image", image));
    }

    // Use provided container/screen name or fall back to metadata.session
    if let Some(ref isolation) = metadata.isolation {
        let name = container_or_screen_name
            .map(String::from)
            .or_else(|| metadata.session.clone());

        if let Some(name) = name {
            match isolation.as_str() {
                "docker" => lines.push(create_spine_line("container", &name)),
                "screen" => lines.push(create_spine_line("screen", &name)),
                "tmux" => lines.push(create_spine_line("tmux", &name)),
                "ssh" => {
                    if let Some(ref endpoint) = metadata.endpoint {
                        lines.push(create_spine_line("endpoint", endpoint));
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(ref user) = metadata.user {
        lines.push(create_spine_line("user", user));
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
}

/// Create a start block for command execution using status spine format
pub fn create_start_block(options: &StartBlockOptions) -> String {
    let mut lines = Vec::new();

    // Header: session and start time
    lines.push(create_spine_line("session", options.session_id));
    lines.push(create_spine_line("start", options.timestamp));

    // Parse and add isolation metadata if present
    if let Some(ref extra) = options.extra_lines {
        let metadata = parse_isolation_metadata(extra);

        if metadata.isolation.is_some() {
            lines.push(create_empty_spine_line());
            lines.extend(generate_isolation_lines(&metadata, None));
        }
    }

    // Empty spine line before command
    lines.push(create_empty_spine_line());

    // Command line
    lines.push(create_command_line(options.command));

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

/// Create a finish block for command execution using status spine format
///
/// Bottom block ordering rules:
/// 1. Result marker (✓ or ✗)
/// 2. finish timestamp
/// 3. duration
/// 4. exit code
/// 5. (repeated isolation metadata, if any)
/// 6. empty spine line
/// 7. log path (always second-to-last)
/// 8. session ID (always last)
pub fn create_finish_block(options: &FinishBlockOptions) -> String {
    let mut lines = Vec::new();

    // Result marker appears first in footer (after program output)
    lines.push(get_result_marker(options.exit_code).to_string());

    // Finish metadata
    lines.push(create_spine_line("finish", options.timestamp));

    if let Some(duration_ms) = options.duration_ms {
        lines.push(create_spine_line("duration", &format_duration(duration_ms)));
    }

    lines.push(create_spine_line("exit", &options.exit_code.to_string()));

    // Repeat isolation metadata if present
    if let Some(ref extra) = options.extra_lines {
        let metadata = parse_isolation_metadata(extra);
        if metadata.isolation.is_some() {
            lines.push(create_empty_spine_line());
            lines.extend(generate_isolation_lines(&metadata, None));
        }
    }

    // Empty spine line before final two entries
    lines.push(create_empty_spine_line());

    // Log and session are ALWAYS last (in that order)
    lines.push(create_spine_line("log", options.log_path));
    lines.push(create_spine_line("session", options.session_id));

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
