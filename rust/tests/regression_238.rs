//! Execute the same finite polling fixture as JavaScript, including clock gaps.
#![cfg(unix)]

use start_command::cgroup_memory::{
    build_cgroup_memory_log_snippet, build_cgroup_sampler_start_snippet,
    build_cgroup_sampler_stop_snippet,
};
use std::{fs, process::Command};

fn sample(mode: &str, interval: Option<&str>, clock_step: &str) -> String {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("sample.sh");
    let final_read = if mode == "final" {
        r#"printf 'oom 3\noom_kill 3\n' > "$START_COMMAND_CGROUP_ROOT/docker/238abc/memory.events""#
    } else {
        ":"
    };
    fs::write(
        &script,
        [
            build_cgroup_sampler_start_snippet("task '238'"),
            r#"wait "$__start_command_cgroup_sampler""#.into(),
            final_read.into(),
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
        .env_remove("START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS")
        .env("START_SAMPLER_CLOCK_STEP", clock_step);
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

#[test]
fn default_interval_and_local_liveness_after_removal() {
    let output = sample("local", None, "5");
    assert_eq!(count(&output, "sleep=5"), 3);
    assert_eq!(count(&output, "{{.State.Running}}"), 1);
    assert_eq!(count(&output, "{{.HostConfig.CgroupnsMode}}"), 1);
    // A readable local cgroup never starts a remote exec, even after removal
    // (issue #242): the liveness probe ends the loop instead.
    assert_eq!(count(&output, "task '238' sh -c"), 0);
}

#[test]
fn override_and_cached_remote_namespace() {
    let output = sample("remote", Some("2"), "5");
    assert_eq!(count(&output, "sleep=2"), 3);
    assert_eq!(count(&output, "{{.HostConfig.CgroupnsMode}}"), 1);
    // One long-lived exec streams every round; liveness is probed once, after
    // the stream ends (issue #242).
    assert_eq!(count(&output, "{{.State.Running}}"), 1);
    assert_eq!(count(&output, "task '238' sh -c"), 1);
    assert!(output.contains("memory.max=67108864 memory.peak=33554432 oom=1 oom_kill=3"));
}

#[test]
fn invalid_intervals_fall_back_without_a_busy_loop() {
    for interval in [
        "",
        "0",
        "000",
        "-1",
        "0.5",
        "nope",
        "1; exit 7",
        "99999999999999999999999999",
    ] {
        assert_eq!(count(&sample("remote", Some(interval), "5"), "sleep=5"), 3);
    }
}

#[test]
fn remote_outages_and_unavailable_diagnostics() {
    for mode in ["shared", "no-shell", "outage"] {
        let output = sample(mode, None, "5");
        assert_eq!(count(&output, "{{.HostConfig.CgroupnsMode}}"), 1);
        // A shared namespace or a missing shell ends sampling at once; an outage
        // falls back to per-round execs, each followed by a liveness probe.
        let (running, execs) = match mode {
            "shared" => (0, 0),
            "no-shell" => (0, 1),
            _ => (4, 4),
        };
        assert_eq!(count(&output, "{{.State.Running}}"), running);
        assert_eq!(count(&output, "task '238' sh -c"), execs);
        if mode == "outage" {
            assert!(output.contains("sample=67108864 33554432 1 3 0 100"));
        } else {
            assert!(output.contains("Memory:     unavailable"));
            assert!(output.contains(if mode == "shared" {
                "namespace=host"
            } else {
                "sh: not found"
            }));
        }
    }
}

#[test]
fn final_read_keeps_conservative_oom_timing() {
    assert!(sample("final", None, "5").contains("sample=67108864 33554432 3 3 0 115"));
    assert!(sample("final", Some("1"), "1").contains("sample=67108864 33554432 3 3 103 103"));
}
