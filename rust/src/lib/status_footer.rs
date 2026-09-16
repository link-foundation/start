//! The anchored terminal footer `start` writes at the end of every log.
//!
//! ```text
//! ==================================================
//! Finished: 2026-07-30 23:36:20.295
//! Exit Code: 0
//! ```
//!
//! Matching the whole block at line starts means a bare `Exit Code: N`
//! substring emitted by the wrapped command (inside a JSON payload, a quoted
//! log excerpt, an `rg` dump, ...) can no longer be mistaken for the footer
//! (issue #150).
//!
//! The `Finished:` line was previously parsed by nobody: `--status` read the
//! exit code out of this block and then stamped `end_time` with the current
//! time, even though the real finish time was sitting one line above the number
//! it had just trusted (issue #170.2).

use chrono::{NaiveDateTime, TimeZone, Utc};

use crate::isolation::isolation_log::{read_log_tail, LOG_TAIL_BYTES};

/// The two facts the terminal footer carries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LogFooter {
    pub exit_code: Option<i32>,
    pub finished_at: Option<String>,
}

fn is_footer_separator_line(line: &str) -> bool {
    line.len() >= 10 && line.chars().all(|c| c == '=')
}

/// Parse the `Finished:` value both footer writers produce.
///
/// `create_log_footer()` writes an ISO timestamp and the shell snippet writes
/// `date -u '+%Y-%m-%d %H:%M:%S.%3N'`; both are UTC. Anything else — a test
/// fixture, a truncated line, a localized date — yields `None` so the caller
/// falls back instead of inventing a finish time.
pub fn parse_footer_timestamp(value: &str) -> Option<String> {
    let text = value.trim().trim_end_matches('Z');
    if text.is_empty() {
        return None;
    }
    let normalized = text.replacen('T', " ", 1);
    let naive = NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%d %H:%M:%S"))
        .ok()?;
    Some(Utc.from_utc_datetime(&naive).to_rfc3339())
}

/// Parse the last complete footer block out of a log tail.
///
/// Returns None fields rather than numbers parsed out of the command's own
/// output: an absent footer is reported as absent.
pub fn parse_footer_from_tail(tail: &str) -> LogFooter {
    let lines: Vec<&str> = tail
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .collect();
    for index in (2..lines.len()).rev() {
        let value = match lines[index].strip_prefix("Exit Code:") {
            Some(value) => value,
            None => continue,
        };
        let finished = match lines[index - 1].strip_prefix("Finished:") {
            Some(finished) => finished,
            None => continue,
        };
        if !is_footer_separator_line(lines[index - 2]) {
            continue;
        }
        if let Ok(code) = value.trim().parse::<i32>() {
            return LogFooter {
                exit_code: Some(code),
                finished_at: parse_footer_timestamp(finished),
            };
        }
    }
    LogFooter::default()
}

/// Read the terminal footer from the end of a log file.
pub fn read_footer_from_log(log_path: &str) -> LogFooter {
    match read_log_tail(log_path, LOG_TAIL_BYTES) {
        Some(tail) => parse_footer_from_tail(&tail),
        None => LogFooter::default(),
    }
}
