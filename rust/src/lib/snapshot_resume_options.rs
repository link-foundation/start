//! Options for the guarded Docker snapshot resume (issue #224):
//!
//! ```text
//! --snapshot-wait <seconds>          wait for the host snapshot lock
//! --snapshot-disk-wait <seconds>     wait for free disk instead of refusing
//! --remove-original-after <seconds>  remove the original only if the
//!                                    replacement still runs after the delay
//! --snapshot-size-hint <bytes>       skip the `docker inspect --size` walk
//! --snapshot-prepare <command>       `docker exec` a command in the original
//!                                    before it is committed
//! ```
//!
//! They only apply to `--resume`. The two waits also read
//! START_SNAPSHOT_LOCK_WAIT and START_SNAPSHOT_DISK_WAIT when the flags are
//! absent, so a supervisor can set them once for every resume it runs.

use crate::args_parser::WrapperOptions;
use serde_json::{json, Value};

/// Parsed snapshot resume options; `None` when the flag was not given.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapshotResumeOptions {
    pub wait: Option<f64>,
    pub disk_wait: Option<f64>,
    pub remove_original_after: Option<f64>,
    pub size_hint: Option<u64>,
    pub prepare: Option<String>,
}

const FLAGS: [&str; 5] = [
    "--snapshot-wait",
    "--snapshot-disk-wait",
    "--remove-original-after",
    "--snapshot-size-hint",
    "--snapshot-prepare",
];

/// JavaScript's `Number.MAX_SAFE_INTEGER`, so both editions accept the same hints.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Parse a non-negative number of seconds; fractions are allowed.
pub fn parse_seconds(value: &str, name: &str) -> Result<f64, String> {
    let text = value.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, "0"));
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    match text.parse::<f64>() {
        Ok(seconds) if digits(whole) && digits(fraction) && seconds.is_finite() => Ok(seconds),
        _ => Err(format!(
            "Invalid {} value: \"{}\". Expected a non-negative number of seconds.",
            name, value
        )),
    }
}

/// Parse a size in bytes; k, m, g and t suffixes are 1024-based.
pub fn parse_size_hint(value: &str) -> Result<u64, String> {
    let text = value.trim().to_lowercase();
    let (number, unit) = match text.char_indices().last() {
        Some((index, suffix)) if "bkmgt".contains(suffix) => (&text[..index], Some(suffix)),
        _ => (text.as_str(), None),
    };
    let multiplier: u64 = match unit {
        None | Some('b') => 1,
        Some('k') => 1 << 10,
        Some('m') => 1 << 20,
        Some('g') => 1 << 30,
        _ => 1 << 40,
    };
    number
        .parse::<u64>()
        .ok()
        .filter(|_| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
        .and_then(|n| n.checked_mul(multiplier))
        .filter(|bytes| *bytes <= MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            format!(
                "Invalid --snapshot-size-hint value: \"{}\". Expected a number of bytes (k, m, g, t suffixes allowed).",
                value
            )
        })
}

fn store(flag: &str, value: &str, options: &mut SnapshotResumeOptions) -> Result<(), String> {
    match flag {
        "--snapshot-size-hint" => options.size_hint = Some(parse_size_hint(value)?),
        "--snapshot-prepare" => {
            if value.trim().is_empty() {
                return Err("--snapshot-prepare requires a non-empty command".to_string());
            }
            options.prepare = Some(value.to_string());
        }
        "--snapshot-wait" => options.wait = Some(parse_seconds(value, flag)?),
        "--snapshot-disk-wait" => options.disk_wait = Some(parse_seconds(value, flag)?),
        _ => options.remove_original_after = Some(parse_seconds(value, flag)?),
    }
    Ok(())
}

/// Parse one snapshot option; returns the arguments consumed, 0 when
/// `args[index]` is not one.
pub fn parse(args: &[String], index: usize, options: &mut WrapperOptions) -> Result<usize, String> {
    let arg = args[index].as_str();
    let (flag, inline) = match arg.split_once('=') {
        Some((flag, value)) => (flag, Some(value)),
        None => (arg, None),
    };
    if !FLAGS.contains(&flag) {
        return Ok(0);
    }
    if let Some(value) = inline {
        store(flag, value, &mut options.snapshot)?;
        return Ok(1);
    }
    // A prepare command may itself start with a dash only through `=`.
    let Some(value) = args.get(index + 1).filter(|value| !value.starts_with('-')) else {
        let kind = match flag {
            "--snapshot-size-hint" => "bytes",
            "--snapshot-prepare" => "command",
            _ => "seconds",
        };
        return Err(format!("Option {} requires a {} argument", flag, kind));
    };
    store(flag, value, &mut options.snapshot)?;
    Ok(2)
}

/// Reject snapshot options outside `--resume` and fill the waits from the
/// environment.
pub fn validate(options: &mut WrapperOptions) -> Result<(), String> {
    validate_with_env(options, &|name| std::env::var(name).ok())
}

pub fn validate_with_env(
    options: &mut WrapperOptions,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let snapshot = &mut options.snapshot;
    if options.resume.is_none() {
        let given = [
            snapshot.wait.is_some(),
            snapshot.disk_wait.is_some(),
            snapshot.remove_original_after.is_some(),
            snapshot.size_hint.is_some(),
            snapshot.prepare.is_some(),
        ];
        return match FLAGS.iter().zip(given).find(|(_, given)| *given) {
            Some((flag, _)) => Err(format!("{} is only valid with --resume", flag)),
            None => Ok(()),
        };
    }
    for (field, name, flag) in [
        (
            &mut snapshot.wait,
            "START_SNAPSHOT_LOCK_WAIT",
            "--snapshot-wait",
        ),
        (
            &mut snapshot.disk_wait,
            "START_SNAPSHOT_DISK_WAIT",
            "--snapshot-disk-wait",
        ),
    ] {
        if field.is_none() {
            if let Some(value) = env(name).filter(|value| !value.is_empty()) {
                *field = Some(parse_seconds(&value, &format!("{} ({})", name, flag))?);
            }
        }
    }
    if snapshot.remove_original_after.is_some() {
        options.remove_original = true;
    }
    Ok(())
}

/// Add the options to the resume `overrides` object.
pub fn insert_overrides(options: &SnapshotResumeOptions, overrides: &mut Value) {
    overrides["snapshotWait"] = json!(options.wait);
    overrides["snapshotDiskWait"] = json!(options.disk_wait);
    overrides["removeOriginalAfter"] = json!(options.remove_original_after);
    overrides["snapshotSizeHint"] = json!(options.size_hint);
    overrides["snapshotPrepare"] = json!(options.prepare);
}

/// What a snapshot resume reads from its `overrides`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapshotSettings {
    pub wait_seconds: f64,
    pub disk_wait_seconds: f64,
    pub size_hint: Option<u64>,
    pub prepare: Option<String>,
    pub remove_original_after: f64,
    /// Lock file instead of START_SNAPSHOT_LOCK (tests).
    pub lock_path: Option<std::path::PathBuf>,
    /// Disk poll interval instead of START_SNAPSHOT_DISK_POLL (tests).
    pub disk_poll_seconds: Option<f64>,
    /// Progress interval instead of START_SNAPSHOT_PROGRESS_INTERVAL (tests).
    pub progress_interval_seconds: Option<f64>,
}

impl SnapshotSettings {
    pub fn from_overrides(overrides: &Value) -> Self {
        let seconds = |key: &str| overrides.get(key).and_then(Value::as_f64);
        Self {
            wait_seconds: seconds("snapshotWait").unwrap_or(0.0),
            disk_wait_seconds: seconds("snapshotDiskWait").unwrap_or(0.0),
            size_hint: overrides.get("snapshotSizeHint").and_then(Value::as_u64),
            prepare: overrides
                .get("snapshotPrepare")
                .and_then(Value::as_str)
                .map(String::from),
            remove_original_after: seconds("removeOriginalAfter").unwrap_or(0.0),
            lock_path: overrides
                .get("snapshotLockPath")
                .and_then(Value::as_str)
                .map(std::path::PathBuf::from),
            disk_poll_seconds: seconds("snapshotDiskPoll"),
            progress_interval_seconds: seconds("snapshotProgressInterval"),
        }
    }
}
