//! Issue #185: allocation events and killed processes cannot establish OOM scope.

use start_command::cgroup_memory::{
    describe_cgroup_oom_scope, format_cgroup_memory, format_cgroup_memory_log_line,
    parse_cgroup_memory_sample, CgroupMemory,
};
use start_command::exit_reason::{
    resolve_exit_reason, resolve_memory_exhaustion, CGROUP_OOM_EXIT_REASON,
};

// Group kills, equal counts, earlier allocation failures, zero and unknown oom.
const SAMPLES: [&str; 5] = [
    "3135373312 3135373312 1 3",
    "3135373312 3135373312 2 2",
    "3135373312 3135373312 4 1",
    "3135373312 3135373312 0 3",
    "3135373312 3135373312 - 3",
];
const NOTE: &str = "OOM kill scope unknown";

#[test]
fn preserves_raw_counters_without_attributing_scope() {
    for sample in SAMPLES {
        let memory = parse_cgroup_memory_sample(sample).unwrap();
        let fields: Vec<_> = sample.split_whitespace().collect();
        let oom = fields[2];
        let kills = fields[3];
        assert_eq!(
            memory,
            CgroupMemory {
                limit_bytes: Some(3_135_373_312),
                peak_bytes: Some(3_135_373_312),
                oom_events: oom.parse().ok(),
                oom_kills: kills.parse().ok(),
            }
        );
        assert_eq!(
            describe_cgroup_oom_scope(&memory).map(|scope| scope.as_str()),
            Some("unknown"),
            "{}",
            sample
        );
        assert_eq!(
            format_cgroup_memory(&memory),
            format!(
                "peak 2.9 GiB of 2.9 GiB limit, oom {}, oom_kill {} ({})",
                if oom == "-" { "unknown" } else { oom },
                kills,
                NOTE
            )
        );
        assert_eq!(
            format_cgroup_memory_log_line(sample),
            Some(format!(
                "Memory:     memory.max=3135373312 memory.peak=3135373312 oom={} oom_kill={} ({})",
                oom, kills, NOTE
            ))
        );
    }
}

#[test]
fn does_not_report_an_oom_scope_when_kills_are_zero_or_unknown() {
    for oom_kills in [Some(0), None] {
        assert_eq!(
            describe_cgroup_oom_scope(&CgroupMemory {
                oom_kills,
                ..Default::default()
            }),
            None
        );
    }
    for sample in ["max - 4 0", "max - 4 -"] {
        assert!(!format_cgroup_memory_log_line(sample)
            .unwrap()
            .contains(NOTE));
    }
}

#[test]
#[cfg(unix)]
fn writes_the_same_unknown_scope_from_the_posix_watcher_shell() {
    use start_command::cgroup_memory::build_cgroup_memory_log_snippet;
    use std::process::Command;

    let dir = tempfile::TempDir::new().unwrap();
    let log_path = dir.path().join("memory.log");
    for sample in SAMPLES.into_iter().chain(["max - 4 0", "max - 4 -"]) {
        std::fs::write(&log_path, "").unwrap();
        let script = format!(
            "__start_command_cgroup='{}'; {}",
            sample,
            build_cgroup_memory_log_snippet("\"$1\"")
        );
        let output = Command::new("/bin/sh")
            .args(["-c", &script, "watcher"])
            .arg(&log_path)
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);
        let fields: Vec<_> = sample.split_whitespace().collect();
        let note = if fields[3].parse::<u64>().unwrap_or(0) > 0 {
            format!(" ({})", NOTE)
        } else {
            String::new()
        };
        assert_eq!(
            std::fs::read_to_string(&log_path).unwrap(),
            format!(
                "Memory:     memory.max={} memory.peak={} oom={} oom_kill={}{}\n",
                fields[0], fields[1], fields[2], fields[3], note
            )
        );
    }
}

#[test]
fn retains_the_exit_code_guard_for_earlier_child_oom_kills() {
    let memory = parse_cgroup_memory_sample(SAMPLES[0]).unwrap();
    for exit_code in [0, 1, 134, 139, 143] {
        assert_ne!(
            resolve_exit_reason(Some(exit_code), None, Some(false), memory.oom_kills).as_deref(),
            Some(CGROUP_OOM_EXIT_REASON)
        );
        assert!(
            resolve_memory_exhaustion(Some(exit_code), None, Some(false), memory.oom_kills)
                .is_none()
        );
    }
    for exit_code in [Some(137), None, Some(-1)] {
        assert_ne!(
            resolve_exit_reason(exit_code, None, Some(false), memory.oom_kills).as_deref(),
            Some(CGROUP_OOM_EXIT_REASON)
        );
        assert!(
            resolve_memory_exhaustion(exit_code, None, Some(false), memory.oom_kills).is_none()
        );
    }
}
