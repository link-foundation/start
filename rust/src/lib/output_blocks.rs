//! Output formatting utilities for nicely rendered command blocks
//!
//! Provides various styles for start/finish blocks to distinguish
//! command output from the $ wrapper output.
//!
//! Available styles:
//! - `rounded` (default): Rounded unicode box borders (╭─╮ ╰─╯)
//! - `heavy`: Heavy unicode box borders (┏━┓ ┗━┛)
//! - `double`: Double line box borders (╔═╗ ╚═╝)
//! - `simple`: Simple dash lines (────────)
//! - `ascii`: Pure ASCII compatible (+--------+)

use std::env;

/// Box drawing characters for different styles
#[derive(Clone, Copy)]
pub struct BoxStyle {
    pub top_left: &'static str,
    pub top_right: &'static str,
    pub bottom_left: &'static str,
    pub bottom_right: &'static str,
    pub horizontal: &'static str,
    pub vertical: &'static str,
}

impl BoxStyle {
    pub const ROUNDED: BoxStyle = BoxStyle {
        top_left: "╭",
        top_right: "╮",
        bottom_left: "╰",
        bottom_right: "╯",
        horizontal: "─",
        vertical: "│",
    };

    pub const HEAVY: BoxStyle = BoxStyle {
        top_left: "┏",
        top_right: "┓",
        bottom_left: "┗",
        bottom_right: "┛",
        horizontal: "━",
        vertical: "┃",
    };

    pub const DOUBLE: BoxStyle = BoxStyle {
        top_left: "╔",
        top_right: "╗",
        bottom_left: "╚",
        bottom_right: "╝",
        horizontal: "═",
        vertical: "║",
    };

    pub const SIMPLE: BoxStyle = BoxStyle {
        top_left: "",
        top_right: "",
        bottom_left: "",
        bottom_right: "",
        horizontal: "─",
        vertical: "",
    };

    pub const ASCII: BoxStyle = BoxStyle {
        top_left: "+",
        top_right: "+",
        bottom_left: "+",
        bottom_right: "+",
        horizontal: "-",
        vertical: "|",
    };
}

/// Default block width
pub const DEFAULT_WIDTH: usize = 60;

/// Get the box style configuration from environment or default
pub fn get_box_style(style_name: Option<&str>) -> BoxStyle {
    let env_style = env::var("START_OUTPUT_STYLE").ok();
    let name = style_name.or(env_style.as_deref()).unwrap_or("rounded");

    match name {
        "heavy" => BoxStyle::HEAVY,
        "double" => BoxStyle::DOUBLE,
        "simple" => BoxStyle::SIMPLE,
        "ascii" => BoxStyle::ASCII,
        _ => BoxStyle::ROUNDED,
    }
}

/// Create a horizontal line
fn create_horizontal_line(width: usize, style: &BoxStyle) -> String {
    style.horizontal.repeat(width)
}

/// Pad or truncate text to fit a specific width
fn pad_text(text: &str, width: usize) -> String {
    if text.len() >= width {
        text[..width].to_string()
    } else {
        format!("{}{}", text, " ".repeat(width - text.len()))
    }
}

/// Create a bordered line with text
fn create_bordered_line(text: &str, width: usize, style: &BoxStyle) -> String {
    if !style.vertical.is_empty() {
        let inner_width = width.saturating_sub(4); // 2 for borders, 2 for padding
        let padded_text = pad_text(text, inner_width);
        format!("{} {} {}", style.vertical, padded_text, style.vertical)
    } else {
        text.to_string()
    }
}

/// Create the top border of a box
fn create_top_border(width: usize, style: &BoxStyle) -> String {
    if !style.top_left.is_empty() {
        let line_width = width.saturating_sub(2); // Subtract corners
        format!(
            "{}{}{}",
            style.top_left,
            create_horizontal_line(line_width, style),
            style.top_right
        )
    } else {
        create_horizontal_line(width, style)
    }
}

/// Create the bottom border of a box
fn create_bottom_border(width: usize, style: &BoxStyle) -> String {
    if !style.bottom_left.is_empty() {
        let line_width = width.saturating_sub(2); // Subtract corners
        format!(
            "{}{}{}",
            style.bottom_left,
            create_horizontal_line(line_width, style),
            style.bottom_right
        )
    } else {
        create_horizontal_line(width, style)
    }
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

/// Create a start block for command execution
pub fn create_start_block(options: &StartBlockOptions) -> String {
    let width = options.width.unwrap_or(DEFAULT_WIDTH);
    let style = get_box_style(options.style);

    let mut lines = Vec::new();

    lines.push(create_top_border(width, &style));
    lines.push(create_bordered_line(
        &format!("Session ID: {}", options.session_id),
        width,
        &style,
    ));
    lines.push(create_bordered_line(
        &format!("Starting at {}: {}", options.timestamp, options.command),
        width,
        &style,
    ));

    // Add extra lines (e.g., isolation info, docker image, etc.)
    if let Some(ref extra) = options.extra_lines {
        for line in extra {
            lines.push(create_bordered_line(line, width, &style));
        }
    }

    lines.push(create_bottom_border(width, &style));

    lines.join("\n")
}

/// Format duration in seconds with appropriate precision
pub fn format_duration(duration_ms: f64) -> String {
    let seconds = duration_ms / 1000.0;
    if seconds < 0.001 {
        "0.001".to_string()
    } else if seconds < 10.0 {
        // For durations under 10 seconds, show 3 decimal places
        format!("{:.3}", seconds)
    } else if seconds < 100.0 {
        format!("{:.2}", seconds)
    } else {
        format!("{:.1}", seconds)
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
    pub style: Option<&'a str>,
    pub width: Option<usize>,
}

/// Create a finish block for command execution
pub fn create_finish_block(options: &FinishBlockOptions) -> String {
    let width = options.width.unwrap_or(DEFAULT_WIDTH);
    let style = get_box_style(options.style);

    let mut lines = Vec::new();

    // Format the finished message with optional duration
    let finished_msg = if let Some(duration_ms) = options.duration_ms {
        format!(
            "Finished at {} in {} seconds",
            options.timestamp,
            format_duration(duration_ms)
        )
    } else {
        format!("Finished at {}", options.timestamp)
    };

    lines.push(create_top_border(width, &style));

    // Add result message first if provided (e.g., "Docker container exited...")
    if let Some(result_msg) = options.result_message {
        lines.push(create_bordered_line(result_msg, width, &style));
    }

    lines.push(create_bordered_line(&finished_msg, width, &style));
    lines.push(create_bordered_line(
        &format!("Exit code: {}", options.exit_code),
        width,
        &style,
    ));
    lines.push(create_bordered_line(
        &format!("Log: {}", options.log_path),
        width,
        &style,
    ));
    lines.push(create_bordered_line(
        &format!("Session ID: {}", options.session_id),
        width,
        &style,
    ));
    lines.push(create_bottom_border(width, &style));

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
