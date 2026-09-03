//! Exit reason hints for finished executions.
//!
//! A numeric exit code alone is frequently misleading: a Bun/Node process that
//! exhausts its heap aborts itself, so the container reports `exitCode 139`
//! with `OOMKilled false` even though the run died of memory exhaustion (issue
//! #162, related to #144, #148 and #151). `start` already reads the tail of the
//! log to find the terminal footer, so the same tail is scanned for well-known
//! fatal markers and the finding is surfaced as an extra `exitReason` field.
//!
//! The same scan answers a narrower question for consumers that key off
//! `oomKilled`: was this run killed by memory exhaustion at all? That answer is
//! surfaced as `memoryExhausted` plus `memoryExhaustedReason`, the log line that
//! carried the evidence (issue #165).
//!
//! Both fields are hints, never verdicts: they never change `status`,
//! `exitCode` or `oomKilled`.

use regex::Regex;

/// Fatal markers, most specific first. The first matching entry wins.
const EXIT_REASON_MARKERS: [(&str, &str); 5] = [
    (
        "memory-exhaustion (v8-heap-limit)",
        r"(?i)FATAL ERROR:[^\r\n]*(?:Reached heap limit|JavaScript heap out of memory)",
    ),
    (
        "memory-exhaustion (v8-heap-limit)",
        r"(?i)JavaScript heap out of memory",
    ),
    (
        "memory-exhaustion (kernel-oom-killer)",
        r"(?i)Out of memory: Kill(?:ed)? process|oom-kill(?:er)?[: ]|Killed process \d+",
    ),
    (
        "memory-exhaustion (go-runtime)",
        r"(?i)fatal error: runtime: out of memory",
    ),
    (
        "memory-exhaustion (allocation-failure)",
        r"(?i)std::bad_alloc|Cannot allocate memory|memory allocation of \d+ bytes failed|Allocation failed - process out of memory|Array buffer allocation failed",
    ),
];

/// Exit codes above 128 encode the signal that killed the process.
/// Only the signals that actually show up in command logs are named.
const SIGNAL_NAMES: [(i32, &str); 10] = [
    (1, "SIGHUP"),
    (2, "SIGINT"),
    (3, "SIGQUIT"),
    (4, "SIGILL"),
    (6, "SIGABRT"),
    (8, "SIGFPE"),
    (9, "SIGKILL"),
    (11, "SIGSEGV"),
    (13, "SIGPIPE"),
    (15, "SIGTERM"),
];

/// Reasons carrying this prefix report memory exhaustion, whatever the
/// mechanism (runtime self-abort, kernel OOM killer, failed allocation).
const MEMORY_EXHAUSTION_PREFIX: &str = "memory-exhaustion";

/// A matched marker line longer than this is truncated: the evidence travels in
/// `--status` output, and some runtimes print very long single-line traces.
const MAX_MARKER_LINE_LENGTH: usize = 300;

/// A fatal marker found in the log: its category and the line that carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitReasonMarker {
    pub reason: String,
    pub line: String,
}

/// The memory-exhaustion observation derived from a log tail (issue #165).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryExhaustion {
    pub memory_exhausted: bool,
    pub memory_exhausted_reason: String,
}

/// Extract the whole (trimmed, length-bounded) line containing byte `index`.
fn extract_line_at(text: &str, index: usize) -> String {
    let start = text[..index].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end = text[index..]
        .find('\n')
        .map(|i| index + i)
        .unwrap_or(text.len());
    let line = text[start..end].trim();
    if line.chars().count() <= MAX_MARKER_LINE_LENGTH {
        return line.to_string();
    }
    let truncated: String = line.chars().take(MAX_MARKER_LINE_LENGTH).collect();
    format!("{}...", truncated)
}

/// Scan log text for the first accepted fatal marker, most specific first.
pub fn find_exit_reason_marker(
    text: Option<&str>,
    accept: impl Fn(&str) -> bool,
) -> Option<ExitReasonMarker> {
    let text = text?;
    if text.is_empty() {
        return None;
    }
    for (reason, pattern) in EXIT_REASON_MARKERS {
        if !accept(reason) {
            continue;
        }
        if let Ok(re) = Regex::new(pattern) {
            if let Some(found) = re.find(text) {
                return Some(ExitReasonMarker {
                    reason: reason.to_string(),
                    line: extract_line_at(text, found.start()),
                });
            }
        }
    }
    None
}

/// Scan log text for a known fatal marker.
pub fn detect_exit_reason(text: Option<&str>) -> Option<String> {
    find_exit_reason_marker(text, |_| true).map(|marker| marker.reason)
}

/// Scan log text for a marker that reports memory exhaustion specifically.
pub fn detect_memory_marker(text: Option<&str>) -> Option<ExitReasonMarker> {
    find_exit_reason_marker(text, |reason| reason.starts_with(MEMORY_EXHAUSTION_PREFIX))
}

/// Decide whether an execution died of memory exhaustion, and say why.
///
/// Only abnormal exits are explained: a command that merely printed a fatal
/// marker (an `rg` dump, a quoted incident log) and then succeeded is not a
/// memory failure. An observation, never a verdict (issue #151).
pub fn resolve_memory_exhaustion(
    exit_code: Option<i32>,
    log_tail: Option<&str>,
    oom_killed: Option<bool>,
) -> Option<MemoryExhaustion> {
    match exit_code {
        Some(code) if code != 0 => {}
        _ => return None,
    }
    if let Some(marker) = detect_memory_marker(log_tail) {
        return Some(MemoryExhaustion {
            memory_exhausted: true,
            memory_exhausted_reason: marker.line,
        });
    }
    if oom_killed == Some(true) {
        return Some(MemoryExhaustion {
            memory_exhausted: true,
            memory_exhausted_reason: "Docker reported State.OOMKilled=true".to_string(),
        });
    }
    None
}

/// Map a shell exit code to the signal name it encodes.
pub fn signal_name_for_exit_code(exit_code: Option<i32>) -> Option<String> {
    let code = exit_code?;
    if code <= 128 || code > 128 + 64 {
        return None;
    }
    SIGNAL_NAMES
        .iter()
        .find(|(signal, _)| *signal == code - 128)
        .map(|(_, name)| name.to_string())
}

/// Resolve the best available hint for why an execution ended.
///
/// Precedence: the log marker (evidence written by the command itself), then
/// the cgroup OOM observation, then the signal encoded in the exit code.
pub fn resolve_exit_reason(
    exit_code: Option<i32>,
    log_tail: Option<&str>,
    oom_killed: Option<bool>,
) -> Option<String> {
    if let Some(reason) = detect_exit_reason(log_tail) {
        return Some(reason);
    }

    if oom_killed == Some(true) {
        return Some("memory-exhaustion (cgroup-oom-killer)".to_string());
    }

    signal_name_for_exit_code(exit_code).map(|name| format!("signal ({})", name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_v8_heap_limit_from_the_incident_log() {
        let tail =
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";
        assert_eq!(
            detect_exit_reason(Some(tail)),
            Some("memory-exhaustion (v8-heap-limit)".to_string())
        );
    }

    #[test]
    fn detects_kernel_oom_killer() {
        assert_eq!(
            detect_exit_reason(Some("Out of memory: Killed process 1234 (bun)")),
            Some("memory-exhaustion (kernel-oom-killer)".to_string())
        );
    }

    #[test]
    fn detects_other_runtimes_reporting_their_own_exhaustion() {
        assert_eq!(
            detect_exit_reason(Some("fatal error: runtime: out of memory")),
            Some("memory-exhaustion (go-runtime)".to_string())
        );
        assert_eq!(
            detect_exit_reason(Some("Array buffer allocation failed")),
            Some("memory-exhaustion (allocation-failure)".to_string())
        );
    }

    #[test]
    fn returns_none_for_ordinary_output() {
        assert_eq!(detect_exit_reason(Some("all tests passed")), None);
        assert_eq!(detect_exit_reason(None), None);
    }

    #[test]
    fn maps_signal_exit_codes() {
        assert_eq!(signal_name_for_exit_code(Some(137)), Some("SIGKILL".into()));
        assert_eq!(signal_name_for_exit_code(Some(139)), Some("SIGSEGV".into()));
        assert_eq!(signal_name_for_exit_code(Some(0)), None);
        assert_eq!(signal_name_for_exit_code(Some(1)), None);
        assert_eq!(signal_name_for_exit_code(None), None);
    }

    #[test]
    fn log_marker_wins_over_signal_and_cgroup_flag() {
        let tail =
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";
        assert_eq!(
            resolve_exit_reason(Some(139), Some(tail), Some(false)),
            Some("memory-exhaustion (v8-heap-limit)".to_string())
        );
    }

    #[test]
    fn memory_marker_returns_the_whole_matched_line() {
        let tail = "building...\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n----- Native stack trace -----\n";
        let marker = detect_memory_marker(Some(tail)).expect("marker");
        assert_eq!(marker.reason, "memory-exhaustion (v8-heap-limit)");
        assert_eq!(
            marker.line,
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"
        );
    }

    #[test]
    fn memory_marker_line_is_length_bounded() {
        let tail = format!(
            "{}JavaScript heap out of memory{}",
            "x".repeat(400),
            "y".repeat(400)
        );
        let marker = detect_memory_marker(Some(&tail)).expect("marker");
        assert!(marker.line.chars().count() <= MAX_MARKER_LINE_LENGTH + 3);
        assert!(marker.line.ends_with("..."));
    }

    #[test]
    fn memory_exhaustion_explains_only_abnormal_exits() {
        let tail =
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory";
        let observed =
            resolve_memory_exhaustion(Some(139), Some(tail), Some(false)).expect("observed");
        assert!(observed.memory_exhausted);
        assert_eq!(observed.memory_exhausted_reason, tail);
        // The same marker with a successful exit is just output, not a failure.
        assert_eq!(
            resolve_memory_exhaustion(Some(0), Some(tail), Some(false)),
            None
        );
        assert_eq!(resolve_memory_exhaustion(None, Some(tail), None), None);
    }

    #[test]
    fn memory_exhaustion_falls_back_to_the_container_flag() {
        let observed =
            resolve_memory_exhaustion(Some(137), Some("no marker"), Some(true)).expect("observed");
        assert_eq!(
            observed.memory_exhausted_reason,
            "Docker reported State.OOMKilled=true"
        );
        assert_eq!(
            resolve_memory_exhaustion(Some(1), Some("no marker"), Some(false)),
            None
        );
    }

    #[test]
    fn falls_back_to_cgroup_observation_then_signal() {
        assert_eq!(
            resolve_exit_reason(Some(137), None, Some(true)),
            Some("memory-exhaustion (cgroup-oom-killer)".to_string())
        );
        assert_eq!(
            resolve_exit_reason(Some(139), Some("no marker here"), Some(false)),
            Some("signal (SIGSEGV)".to_string())
        );
        assert_eq!(resolve_exit_reason(Some(0), Some("fine"), None), None);
    }
}
