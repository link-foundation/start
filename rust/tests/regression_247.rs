//! Issue #247: unreadable cgroup counters (no delegated `memory` controller)
//! stop the sampler instead of one `docker exec` and one liveness probe per
//! interval, and other failed rounds back off exponentially. Mirrors
//! `js/test/regression-247.js` on the shared fixture of issue #238.
#![cfg(unix)]

use start_command::cgroup_memory::{
    build_cgroup_memory_log_snippet, build_cgroup_sampler_start_snippet,
    build_cgroup_sampler_stop_snippet, CGROUP_SAMPLE_BACKOFF_MAX_SECONDS, CGROUP_UNREADABLE_EXIT,
};
use std::{fs, process::Command};

fn sample(mode: &str, interval: Option<&str>) -> String {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("sample.sh");
    fs::write(
        &script,
        [
            build_cgroup_sampler_start_snippet("task '238'"),
            r#"wait "$__start_command_cgroup_sampler""#.into(),
            build_cgroup_sampler_stop_snippet(),
            r#"printf 'sample=%s\n' "$__start_command_cgroup""#.into(),
            build_cgroup_memory_log_snippet(r#""$TMPDIR/memory.log""#),
            r#"cat "$TMPDIR/memory.log" "$TMPDIR/calls""#.into(),
            r#"sed 's/^/sleep=/' "$TMPDIR/sleeps""#.into(),
            r#"for file in "$TMPDIR"/start-command-cgroup*; do [ ! -e "$file" ] || exit 1; done"#
                .into(),
        ]
        .join("; "),
    )
    .unwrap();
    let mut command = Command::new("/bin/sh");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../experiments/issue-238-cgroup-polling.sh"
        ))
        .arg(mode)
        .arg(&script)
        .env_remove("START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS");
    if let Some(interval) = interval {
        command.env("START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS", interval);
    }
    let result = command.output().unwrap();
    assert!(result.status.success(), "{:?}", result);
    String::from_utf8(result.stdout).unwrap()
}

fn count(output: &str, text: &str) -> usize {
    output.lines().filter(|line| line.contains(text)).count()
}

fn sleeps(output: &str) -> Vec<u64> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix("sleep="))
        .map(|value| value.parse().unwrap())
        .collect()
}

fn unreadable() -> String {
    format!(
        "Memory:     unavailable (local cgroup unavailable; Docker exec exit={CGROUP_UNREADABLE_EXIT}: private cgroup v2 counters unreadable)"
    )
}

#[test]
fn stream_exit_3_stops_without_per_round_execs_or_probes() {
    let output = sample("no-memory", None);
    assert!(output.contains("sample=\n"), "{output}");
    assert!(output.contains(&unreadable()), "{output}");
    assert_eq!(count(&output, "exec -i task '238' sh -c"), 1);
    assert_eq!(count(&output, "task '238' sh -c"), 1);
    assert_eq!(count(&output, "{{.State.Running}}"), 0);
    assert!(sleeps(&output).is_empty());
}

#[test]
fn per_round_exit_3_stops() {
    // The stream fails for a transient reason first, so one per-round exec
    // runs; its real read finds no memory.events.
    let output = sample("no-memory-outage", None);
    assert!(output.contains(&unreadable()), "{output}");
    assert_eq!(count(&output, "exec -i task '238' sh -c"), 1);
    assert_eq!(count(&output, "exec task '238' sh -c"), 1);
    assert_eq!(count(&output, "{{.State.Running}}"), 1);
    assert_eq!(sleeps(&output).len(), 1);
}

#[test]
fn per_round_missing_shell_stops() {
    let output = sample("no-shell-outage", None);
    assert!(
        output.contains("Docker exec exit=127: sh: not found"),
        "{output}"
    );
    assert_eq!(count(&output, "exec task '238' sh -c"), 1);
    assert_eq!(count(&output, "{{.State.Running}}"), 1);
}

#[test]
fn per_round_read_reports_exit_3() {
    let snippet = build_cgroup_sampler_start_snippet("task");
    assert!(snippet.contains(&format!(
        "__start_command_cgroup_read /sys/fs/cgroup || exit {CGROUP_UNREADABLE_EXIT}"
    )));
    assert!(snippet.contains("3|126|127) break;;"));
}

#[test]
fn failed_rounds_back_off_exponentially() {
    // Round 0 streams a sample; the stream, then per-round execs, fail.
    assert_eq!(sleeps(&sample("outage", None)), [5, 10, 20]);
    let max = CGROUP_SAMPLE_BACKOFF_MAX_SECONDS;
    assert_eq!(sleeps(&sample("outage", Some("40"))), [40, max, max]);
    // Never less than a longer interval.
    assert_eq!(sleeps(&sample("outage", Some("100"))), [100, 100, 100]);
}

#[test]
fn samples_keep_the_interval() {
    assert_eq!(sleeps(&sample("remote", Some("2"))), [2, 2, 2]);
    assert_eq!(sleeps(&sample("local", None)), [5, 5, 5]);
}
