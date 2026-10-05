//! Random delay before each launch-time kill recovery (issue #181):
//!
//! ```text
//! --on-kill-resume-delay <min[-max]>   seconds; one number is a fixed delay,
//!                                      0 (the default) resumes at once
//! ```
//!
//! One host-wide OOM event can kill several detached docker executions at the
//! same moment. Without a delay every watcher resumes its container in the
//! same second, all of them rebuild their working sets at once, and the next
//! OOM event follows. A uniformly random delay spreads the recoveries out.

use std::time::Duration;

use serde_json::Value;

/// How often a pending recovery checks whether a stop was requested.
pub const CANCEL_CHECK_INTERVAL_MS: u64 = 1000;

/// A delay range in seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecoveryDelayRange {
    pub min_seconds: f64,
    pub max_seconds: f64,
}

fn parse_seconds(text: &str) -> Option<f64> {
    let (whole, fraction) = match text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (text, None),
    };
    let digits = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|fraction| !digits(fraction)) {
        return None;
    }
    text.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// Parse `30-90`, `45` or `0`; `None` when malformed or `max < min`.
pub fn parse_recovery_delay_range(value: &str) -> Option<RecoveryDelayRange> {
    let text = value.trim();
    let (min, max) = match text.split_once('-') {
        Some((min, max)) => (parse_seconds(min)?, parse_seconds(max)?),
        None => {
            let seconds = parse_seconds(text)?;
            (seconds, seconds)
        }
    };
    (max >= min).then_some(RecoveryDelayRange {
        min_seconds: min,
        max_seconds: max,
    })
}

fn format_seconds(seconds: f64) -> String {
    // `{}` prints 30 for 30.0 and 1.5 for 1.5, like JavaScript's `${n}`.
    format!("{}", seconds)
}

/// `30-90` for a range, `45` for a fixed delay.
pub fn format_recovery_delay_range(range: &RecoveryDelayRange) -> String {
    if range.min_seconds == range.max_seconds {
        format_seconds(range.min_seconds)
    } else {
        format!(
            "{}-{}",
            format_seconds(range.min_seconds),
            format_seconds(range.max_seconds)
        )
    }
}

/// Validate and normalize the `--on-kill-resume-delay` argument.
pub fn parse_on_kill_resume_delay_value(value: &str) -> Result<String, String> {
    parse_recovery_delay_range(value)
        .map(|range| format_recovery_delay_range(&range))
        .ok_or_else(|| {
            format!(
                "Invalid --on-kill-resume-delay value: \"{}\". Expected seconds as <min>[-<max>] with max >= min, e.g. 30-90.",
                value
            )
        })
}

/// The normalized non-zero delay range, or `None` when there is no delay.
pub fn effective_on_kill_resume_delay(value: Option<&str>) -> Option<String> {
    let range = parse_recovery_delay_range(value?)?;
    (range.max_seconds > 0.0).then(|| format_recovery_delay_range(&range))
}

/// The delay range stored in a record option (a string, or a number when the
/// record codec turned `45` into one).
pub fn record_on_kill_resume_delay(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => effective_on_kill_resume_delay(Some(text)),
        Value::Number(number) => effective_on_kill_resume_delay(Some(&number.to_string())),
        _ => None,
    }
}

/// A uniformly random number in `[0, 1)` from the OS random source behind
/// `uuid` v4, so no extra dependency is needed.
pub fn system_random() -> f64 {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let mut word = [0u8; 8];
    word.copy_from_slice(&bytes[..8]);
    // 53 random bits, the precision of an f64 mantissa.
    (u64::from_le_bytes(word) >> 11) as f64 / (1u64 << 53) as f64
}

/// Pick a uniformly random delay in whole milliseconds; 0 without a range.
pub fn pick_recovery_delay_ms(value: Option<&str>, random: &dyn Fn() -> f64) -> u64 {
    let Some(range) = value.and_then(parse_recovery_delay_range) else {
        return 0;
    };
    let min_ms = range.min_seconds * 1000.0;
    let max_ms = range.max_seconds * 1000.0;
    (min_ms + (max_ms - min_ms) * random()).round() as u64
}

/// `42s`, `42.5s`.
pub fn format_recovery_delay(delay_ms: u64) -> String {
    format!("{}s", (delay_ms as f64 / 100.0).round() / 10.0)
}

/// Block the current thread.
pub fn system_sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

/// Wait out the delay in short steps, giving up as soon as `should_cancel`
/// returns true (a `--stop` during the wait). Returns true when cancelled.
pub fn wait_for_recovery_delay(
    delay_ms: u64,
    sleep: &dyn Fn(u64),
    should_cancel: &dyn Fn() -> bool,
) -> bool {
    let mut remaining = delay_ms;
    while remaining > 0 {
        if should_cancel() {
            return true;
        }
        let step = remaining.min(CANCEL_CHECK_INTERVAL_MS);
        sleep(step);
        remaining -= step;
    }
    should_cancel()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_random_stays_in_the_unit_interval() {
        for _ in 0..1000 {
            let value = system_random();
            assert!((0.0..1.0).contains(&value));
        }
    }
}
