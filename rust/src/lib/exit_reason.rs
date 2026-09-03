//! Exit reason hints for finished executions.
//!
//! A numeric exit code alone is frequently misleading: a Bun/Node process that
//! exhausts its heap aborts itself, so the container reports `exitCode 139`
//! with `OOMKilled false` even though the run died of memory exhaustion (issue
//! #162, related to #144, #148 and #151). `start` already reads the tail of the
//! log to find the terminal footer, so the same tail is scanned for well-known
//! fatal markers and the finding is surfaced as an extra `exitReason` field.
//!
//! `exitReason` is a hint, never a verdict: it never changes `status`,
//! `exitCode` or `oomKilled`.

use regex::Regex;

/// Fatal markers, most specific first. The first matching entry wins.
const EXIT_REASON_MARKERS: [(&str, &str); 4] = [
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
        "memory-exhaustion (allocation-failure)",
        r"(?i)std::bad_alloc|Cannot allocate memory|memory allocation of \d+ bytes failed|Allocation failed - process out of memory",
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

/// Scan log text for a known fatal marker.
pub fn detect_exit_reason(text: Option<&str>) -> Option<String> {
    let text = text?;
    if text.is_empty() {
        return None;
    }
    for (reason, pattern) in EXIT_REASON_MARKERS {
        if let Ok(re) = Regex::new(pattern) {
            if re.is_match(text) {
                return Some(reason.to_string());
            }
        }
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
