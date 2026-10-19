//! Steps around the `docker commit` of a snapshot resume (issue #224):
//!
//! - `--snapshot-prepare <command>` runs in the stopped original before the
//!   commit: `docker start`, `docker exec ... sh -c <command>`, and always a
//!   `docker kill` afterwards. Starting the original runs its own command
//!   again, so this is only for containers whose start is known to be safe.
//! - Progress lines while `docker commit` runs, which prints nothing itself.
//! - `--remove-original-after <seconds>`: remove the stopped original only if
//!   the replacement is still running after the delay.

use crate::docker_cleanup::docker_command;
use crate::execution_control::{CommandRunOutput, CommandRunner};
use crate::isolation::isolation_log::append_log_file;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const DEFAULT_PROGRESS_INTERVAL_SECONDS: f64 = 60.0;
/// Upper bound for one `--snapshot-prepare`; the original is killed after.
const DEFAULT_PREPARE_TIMEOUT_SECONDS: f64 = 600.0;

/// Format a duration the way the progress lines print it: "45s", "12 min".
pub fn format_elapsed(seconds: f64) -> String {
    let whole = seconds.max(0.0).floor() as u64;
    if whole < 60 {
        return format!("{}s", whole);
    }
    match whole % 60 {
        0 => format!("{} min", whole / 60),
        rest => format!("{} min {}s", whole / 60, rest),
    }
}

fn positive_seconds(value: Option<String>, fallback: f64) -> f64 {
    value
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .unwrap_or(fallback)
}

pub fn progress_interval_seconds() -> f64 {
    positive_seconds(
        std::env::var("START_SNAPSHOT_PROGRESS_INTERVAL").ok(),
        DEFAULT_PROGRESS_INTERVAL_SECONDS,
    )
}

/// Where the snapshot steps report: the execution log and `notify`.
pub struct SnapshotReporter<'a> {
    pub log_path: &'a str,
    pub notify: &'a (dyn Fn(&str) + Sync),
}

impl SnapshotReporter<'_> {
    pub fn log(&self, line: &str) {
        if !self.log_path.is_empty() {
            append_log_file(&PathBuf::from(self.log_path), &format!("{}\n", line));
        }
    }

    pub fn report(&self, line: &str) {
        self.log(line);
        (self.notify)(line);
    }
}

/// Run `docker commit` and report the elapsed time every interval.
pub fn commit_with_progress<R: CommandRunner + ?Sized>(
    runner: &R,
    command: &str,
    args: &[String],
    session_name: &str,
    reporter: &SnapshotReporter,
    interval_seconds: f64,
) -> CommandRunOutput {
    let started = Instant::now();
    let interval = Duration::from_secs_f64(interval_seconds.max(0.001));
    let (done, finished) = mpsc::channel::<()>();
    let result = std::thread::scope(|scope| {
        scope.spawn(move || {
            while let Err(mpsc::RecvTimeoutError::Timeout) = finished.recv_timeout(interval) {
                reporter.report(&format!(
                    "[Resume] snapshotting {}: {} elapsed (docker commit reports no progress)",
                    session_name,
                    format_elapsed(started.elapsed().as_secs_f64())
                ));
            }
        });
        let result = runner.run(command, args);
        let _ = done.send(());
        result
    });
    if result.success {
        reporter.report(&format!(
            "[Resume] snapshot of {} committed after {}",
            session_name,
            format_elapsed(started.elapsed().as_secs_f64())
        ));
    }
    result
}

fn detail(result: &CommandRunOutput, fallback: &str) -> String {
    let stderr = result.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    if let Some(error) = &result.error {
        return error.clone();
    }
    match result.status {
        Some(code) => format!("exit code {}", code),
        None => fallback.to_string(),
    }
}

/// Run `--snapshot-prepare` in the stopped original. A failure is reported and
/// the snapshot continues with the files as they are.
pub fn run_snapshot_prepare<R: CommandRunner + ?Sized>(
    session_name: &str,
    prepare: &str,
    runner: &R,
    reporter: &SnapshotReporter,
) -> (bool, String) {
    let docker = docker_command().to_string_lossy().to_string();
    let started = runner.run(&docker, &["start".into(), session_name.into()]);
    if !started.success {
        let message = format!(
            "[Resume] snapshot prepare skipped: could not start {}: {}",
            session_name,
            detail(&started, "docker start failed")
        );
        reporter.report(&message);
        return (false, message);
    }
    let timeout = positive_seconds(
        std::env::var("START_SNAPSHOT_PREPARE_TIMEOUT").ok(),
        DEFAULT_PREPARE_TIMEOUT_SECONDS,
    );
    let result = runner.run_with_timeout(
        &docker,
        &[
            "exec".into(),
            session_name.into(),
            "sh".into(),
            "-c".into(),
            prepare.into(),
        ],
        Duration::from_secs_f64(timeout),
    );
    // Never commit a running original, and never leave it running.
    runner.run(&docker, &["kill".into(), session_name.into()]);
    runner.run(&docker, &["wait".into(), session_name.into()]);
    let message = if result.success {
        format!("[Resume] snapshot prepare finished in {}", session_name)
    } else {
        format!(
            "[Resume] snapshot prepare failed in {} ({}); snapshotting the files as they are",
            session_name,
            detail(&result, "docker exec failed")
        )
    };
    reporter.report(&message);
    (result.success, message)
}

/// Remove the stopped original once the replacement has survived the delay.
/// Returns the note describing what happened.
pub fn remove_original_after<R: CommandRunner + ?Sized>(
    original: &str,
    replacement: &str,
    delay_seconds: f64,
    runner: &R,
    reporter: &SnapshotReporter,
    sleep: &dyn Fn(Duration),
) -> String {
    reporter.report(&format!(
        "[Resume] Checking {} again in {} before removing {}",
        replacement,
        format_elapsed(delay_seconds),
        original
    ));
    sleep(Duration::from_secs_f64(delay_seconds.max(0.0)));
    let docker = docker_command().to_string_lossy().to_string();
    let running = runner.run(
        &docker,
        &[
            "inspect".into(),
            "-f".into(),
            "{{.State.Running}}".into(),
            replacement.into(),
        ],
    );
    let note = if running.success && running.stdout.trim() == "true" {
        let removed = runner.run(&docker, &["rm".into(), original.into()]);
        if removed.success {
            format!("Stopped original container removed: {}", original)
        } else {
            format!(
                "Original container retained: {}",
                detail(&removed, "docker rm failed")
            )
        }
    } else {
        format!(
            "Original container retained: the snapshot container is not running {} after launch.",
            format_elapsed(delay_seconds)
        )
    };
    reporter.log(&note);
    note
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_elapsed_like_the_js_edition() {
        assert_eq!(format_elapsed(45.9), "45s");
        assert_eq!(format_elapsed(60.0), "1 min");
        assert_eq!(format_elapsed(125.0), "2 min 5s");
        assert_eq!(format_elapsed(-3.0), "0s");
    }
}
