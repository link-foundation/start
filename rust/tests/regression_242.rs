//! Issue #242: one long-lived `docker exec -i`, paced by host ticks, per
//! sampler instead of one exec per round, liveness probed only after a round
//! without a sample, and `START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS=off`.
//! Mirrors `js/test/regression-242.js`; the per-round counts are in
//! regression_238.
#![cfg(unix)]

use start_command::cgroup_memory::{
    build_cgroup_memory_log_snippet, build_cgroup_sampler_start_snippet,
    build_cgroup_sampler_stop_snippet, build_cgroup_stream_script, CGROUP_SAMPLING_OFF_REASON,
    CGROUP_STREAM_NAME,
};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::{fs, thread, time::Duration};

const EVENTS: &str = "low 0\nhigh 0\nmax 4\noom 2\noom_kill 1\noom_group_kill 0\n";

fn write_executable(file: &Path, lines: &[&str]) {
    fs::write(file, format!("{}\n", lines.join("\n"))).unwrap();
    fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Runs the in-container loop with an empty PATH, so any `cat`, `sed`, `cut`
/// or `sleep` would fail, and `ticks` newlines from the host on stdin.
fn stream(files: &[(&str, &str)], ticks: usize) -> (Option<i32>, String, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let cgroup = dir.path().join("cgroup");
    let bin = dir.path().join("bin");
    fs::create_dir(&cgroup).unwrap();
    fs::create_dir(&bin).unwrap();
    for (name, content) in files {
        fs::write(cgroup.join(name), content).unwrap();
    }
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(build_cgroup_stream_script())
        .arg(CGROUP_STREAM_NAME)
        .arg(&cgroup)
        .env_clear()
        .env("PATH", &bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // A failed loop may close stdin early; its exit status is what counts.
    let _ = child
        .stdin
        .take()
        .unwrap()
        .write_all("\n".repeat(ticks).as_bytes());
    let output = child.wait_with_output().unwrap();
    (
        output.status.code(),
        String::from_utf8(output.stdout).unwrap(),
        String::from_utf8(output.stderr).unwrap(),
        cgroup.display().to_string(),
    )
}

#[test]
fn stream_prints_one_line_per_tick_with_builtins() {
    let (status, stdout, stderr, cgroup) = stream(
        &[
            ("memory.events", EVENTS),
            ("memory.max", "max\n"),
            ("memory.peak", "1234\n"),
        ],
        2,
    );
    assert_eq!(
        stdout,
        format!("max 1234 2 1 {cgroup}\nmax 1234 2 1 {cgroup}\n")
    );
    // End of input (the sampler is gone) ends the loop.
    assert_eq!(status, Some(0));
    assert_eq!(stderr, "");
}

#[test]
fn stream_prints_dashes_and_waits_for_a_tick() {
    let (status, stdout, _, cgroup) = stream(&[("memory.events", EVENTS)], 1);
    assert_eq!(stdout, format!("- - 2 1 {cgroup}\n"));
    assert_eq!(status, Some(0));
    let (status, stdout, _, _) = stream(&[("memory.events", EVENTS)], 0);
    assert_eq!(stdout, "");
    assert_eq!(status, Some(0));
}

#[test]
fn stream_exits_3_on_unreadable_counters() {
    for files in [
        &[][..],
        &[("memory.events", "oom 1\n")][..],
        &[("memory.events", "oom x\noom_kill 1\n")][..],
    ] {
        let (status, stdout, _, _) = stream(files, 2);
        assert_eq!(stdout, "");
        assert_eq!(status, Some(3));
    }
}

#[test]
fn snippet_matches_javascript_byte_for_byte() {
    let golden = include_str!("../../parity/fixtures/cgroup-sampler-start-242.sh");
    assert_eq!(
        format!("{}\n", build_cgroup_sampler_start_snippet("task '242'")),
        golden
    );
    let snippet = build_cgroup_sampler_start_snippet("task");
    assert!(snippet.contains("| docker exec -i 'task' sh -c "));
    assert!(snippet.contains(&format!("{CGROUP_STREAM_NAME} /sys/fs/cgroup 2>&1")));
    assert!(snippet.contains("__start_command_cgroup_read /sys/fs/cgroup"));
    assert!(snippet.contains("*[!0-9]*|'') __scs_interval=5;;"));
}

struct Run {
    output: String,
    calls: String,
    pid: Option<i32>,
}

/// Runs the start snippet, `between`, the stop snippet, and prints the results.
fn run(interval: &str, between: &str) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    fs::create_dir(&bin).unwrap();
    // A daemon reached through a mounted socket: no local cgroup, private
    // namespace, and an exec that answers each tick until its input ends.
    let guard = format!("    [ \"$2 $7\" = \"-i {CGROUP_STREAM_NAME}\" ] || exit 1");
    write_executable(
        &bin.join("docker"),
        &[
            "#!/bin/sh",
            "printf '%s\\n' \"$*\" >> \"$TMPDIR/calls\"",
            "case \"$1 $3\" in",
            "  *HostConfig.Memory*) echo 0 ;;",
            "  *CgroupnsMode*) echo private ;;",
            "  *State.Pid*) echo 0 ;;",
            // Never asked when the stream works; ends a regressed sampler.
            "  *State.Running*) echo false ;;",
            "  *Id*) echo remote242 ;;",
            "  exec*)",
            &guard,
            "    echo $$ > \"$TMPDIR/exec.pid\"",
            "    while read -r tick; do echo '67108864 1048576 0 0 /sys/fs/cgroup'; done ;;",
            "esac",
        ],
    );
    let script = [
        build_cgroup_sampler_start_snippet("task-242"),
        between.to_string(),
        build_cgroup_sampler_stop_snippet(),
        r#"printf 'sample=%s\n' "$__start_command_cgroup""#.into(),
        build_cgroup_memory_log_snippet(r#""$TMPDIR/memory.log""#),
        r#"cat "$TMPDIR/memory.log""#.into(),
        r#"for file in "$TMPDIR"/start-command-cgroup*; do [ ! -e "$file" ] || echo "left: $file"; done"#.into(),
    ]
    .join("; ");
    let hidden = dir.path().join("hidden");
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .env("TMPDIR", dir.path())
        .env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        )
        .env("START_COMMAND_CGROUP_ROOT", &hidden)
        .env("START_COMMAND_PROC_ROOT", &hidden)
        .env("START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS", interval)
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    Run {
        output: String::from_utf8(output.stdout).unwrap(),
        calls: fs::read_to_string(dir.path().join("calls")).unwrap_or_default(),
        pid: fs::read_to_string(dir.path().join("exec.pid"))
            .ok()
            .and_then(|pid| pid.trim().parse().ok()),
    }
}

fn alive(pid: i32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[test]
fn one_exec_samples_and_stops_with_the_sampler() {
    let run = run("1", "sleep 2");
    let sample = run
        .output
        .lines()
        .find_map(|line| line.strip_prefix("sample="))
        .unwrap();
    assert!(
        sample.starts_with("67108864 1048576 0 0 0 "),
        "{}",
        run.output
    );
    assert!(run
        .output
        .contains("Memory:     memory.max=67108864 memory.peak=1048576 oom=0 oom_kill=0"));
    assert!(!run.output.contains("left:"));
    assert_eq!(
        run.calls
            .lines()
            .filter(|line| line.starts_with("exec "))
            .count(),
        1
    );
    // A streaming exec proves liveness; Docker is never asked.
    assert!(!run.calls.contains("{{.State.Running}}"));
    // Once the reader is gone, the next tick ends the exec and the ticker.
    let pid = run.pid.unwrap();
    for _ in 0..50 {
        if !alive(pid) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    assert!(!alive(pid));
}

#[test]
fn off_disables_sampling() {
    for value in ["off", "OFF", "Off"] {
        let run = run(value, r#"wait "$__start_command_cgroup_sampler""#);
        assert!(run.output.contains("sample=\n"));
        assert!(run.output.contains(&format!(
            "Memory:     unavailable ({CGROUP_SAMPLING_OFF_REASON}) memory.limit=0 (HostConfig)"
        )));
        assert!(!run.output.contains("left:"));
        // Only the HostConfig.Memory lookup that the post-mortem prints.
        assert_eq!(run.calls, "inspect -f {{.HostConfig.Memory}} task-242\n");
    }
}
