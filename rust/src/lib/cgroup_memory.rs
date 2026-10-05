//! cgroup v2 memory counters of a detached docker container (issue #182).
//!
//! Docker's `State.OOMKilled` is container-wide and sticky (moby/moby#43564):
//! it says that *some* process in the container was OOM-killed at some point,
//! but not how many, not whether the container hit its own `--memory` limit or
//! the whole host ran out, and not how close the execution came to its limit.
//! The kernel provides raw counters per cgroup
//! (<https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files>):
//!
//! ```text
//! memory.events `oom`       allocation events reaching the memory limit
//! memory.events `oom_kill`  processes killed here by *any* OOM killer
//! memory.peak / memory.max  peak usage (Linux 5.19+) and limit (`max` when
//!                           unlimited)
//! ```
//! These counters have different units and are hierarchical. A group OOM can
//! kill several processes for one allocation event; earlier allocation events
//! can also coexist with a later host OOM. Their comparison cannot establish
//! container, parent or host scope (issue #185).
//!
//! The cgroup is removed when the container stops, so the values cannot be read
//! afterwards. The detached completion watcher therefore samples them while the
//! container runs and hands the last sample to the post-mortem, the finalizer
//! and the recovery step. Best effort by design: no cgroup v2, a remote docker
//! daemon or a hidden `/proc` leave the counters unknown, and a kill in the last
//! sampling interval can be missed when the cgroup is gone before the final
//! read.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::isolation::isolation_log::shell_quote;

/// Seconds between two samples of a running container's cgroup.
pub const CGROUP_SAMPLE_INTERVAL_SECONDS: u64 = 1;

/// Shell variables used by the sampler snippets.
pub mod cgroup_shell_vars {
    /// Last sample: `<memory.max> <memory.peak> <oom> <oom_kill>`.
    pub const SAMPLE: &str = "__start_command_cgroup";
    pub const SAMPLER: &str = "__start_command_cgroup_sampler";
    pub const FILE: &str = "__start_command_cgroup_file";
}

/// Where the OOM killer that killed processes in the container came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OomScope {
    /// Raw counters do not establish container, parent or host scope.
    Unknown,
    /// Retained scope name; raw counters alone cannot establish it.
    ContainerLimit,
    /// Retained scope name; raw counters alone cannot establish it.
    HostOrParent,
}

impl OomScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            OomScope::Unknown => "unknown",
            OomScope::ContainerLimit => "container-limit",
            OomScope::HostOrParent => "host-or-parent",
        }
    }

    pub fn note(&self) -> &'static str {
        match self {
            OomScope::Unknown => "OOM kill scope unknown",
            OomScope::ContainerLimit => "the container hit its own memory limit",
            OomScope::HostOrParent => "a host-wide or parent cgroup OOM killed processes here",
        }
    }
}

/// The counters of one sample. `limit_bytes` is `None` without a limit.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CgroupMemory {
    pub limit_bytes: Option<u64>,
    pub peak_bytes: Option<u64>,
    pub oom_events: Option<u64>,
    pub oom_kills: Option<u64>,
}

/// Shell functions shared by the sampler and its final read:
///
/// ```text
/// __start_command_cgroup_dir NAME  print the container's cgroup v2 directory
/// __start_command_cgroup_read DIR  print `<max> <peak> <oom> <oom_kill> DIR`
/// ```
///
/// The directory comes from `/proc/<.State.Pid>/cgroup` (`0::<path>`), which
/// covers the systemd and cgroupfs drivers, `--cgroup-parent` and rootless
/// docker alike; the two default layouts are fallbacks. A candidate must name
/// the container ID, so a PID reported by a remote daemon can never select an
/// unrelated local cgroup. `START_COMMAND_CGROUP_ROOT` and
/// `START_COMMAND_PROC_ROOT` replace `/sys/fs/cgroup` and `/proc` (tests).
pub fn build_cgroup_functions_snippet() -> String {
    [
        concat!(
            "__start_command_cgroup_dir() { __scd_id=$(docker inspect -f '{{.Id}}' \"$1\" 2>/dev/null); ",
            "[ -n \"$__scd_id\" ] || return 1; ",
            "__scd_pid=$(docker inspect -f '{{.State.Pid}}' \"$1\" 2>/dev/null); __scd_rel=''; ",
            "case \"$__scd_pid\" in ''|0|*[!0-9]*) ;; ",
            "*) __scd_rel=$(sed -n 's/^0:://p' \"${START_COMMAND_PROC_ROOT:-/proc}/$__scd_pid/cgroup\" 2>/dev/null);; esac; ",
            "__scd_root=${START_COMMAND_CGROUP_ROOT:-/sys/fs/cgroup}; ",
            "for __scd_dir in ${__scd_rel:+\"$__scd_root$__scd_rel\"} ",
            "\"$__scd_root/system.slice/docker-$__scd_id.scope\" \"$__scd_root/docker/$__scd_id\"; do ",
            "case \"$__scd_dir\" in *\"$__scd_id\"*) if [ -r \"$__scd_dir/memory.events\" ]; then ",
            "printf '%s' \"$__scd_dir\"; return 0; fi;; esac; done; return 1; }",
        ),
        concat!(
            "__start_command_cgroup_read() { __scr_events=$(cat \"$1/memory.events\" 2>/dev/null) || return 1; ",
            "__scr_oom=$(printf '%s\\n' \"$__scr_events\" | sed -n 's/^oom //p'); ",
            "__scr_kill=$(printf '%s\\n' \"$__scr_events\" | sed -n 's/^oom_kill //p'); ",
            "__scr_max=$(cat \"$1/memory.max\" 2>/dev/null); __scr_peak=$(cat \"$1/memory.peak\" 2>/dev/null); ",
            "printf '%s %s %s %s %s\\n' \"${__scr_max:--}\" \"${__scr_peak:--}\" ",
            "\"${__scr_oom:--}\" \"${__scr_kill:--}\" \"$1\"; }",
        ),
    ]
    .join("; ")
}

/// Shell fragment starting the background sampler. It writes each sample to a
/// temp file with `mv`, so the watcher never reads a half-written line, and
/// ends by itself once the cgroup is gone.
pub fn build_cgroup_sampler_start_snippet(container_name: &str) -> String {
    use cgroup_shell_vars::{FILE, SAMPLER};
    [
        build_cgroup_functions_snippet(),
        format!("{}=\"${{TMPDIR:-/tmp}}/start-command-cgroup.$$\"", FILE),
        format!("rm -f \"${f}\" \"${f}.tmp\"", f = FILE),
        format!(
            "( __scs_dir=$(__start_command_cgroup_dir {name}) || exit 0; \
             while __scs_line=$(__start_command_cgroup_read \"$__scs_dir\"); do \
             printf '%s\\n' \"$__scs_line\" > \"${f}.tmp\" && mv -f \"${f}.tmp\" \"${f}\"; \
             sleep {interval}; done ) >/dev/null 2>&1 & {sampler}=$!",
            name = shell_quote(container_name),
            f = FILE,
            interval = CGROUP_SAMPLE_INTERVAL_SECONDS,
            sampler = SAMPLER,
        ),
    ]
    .join("; ")
}

/// Shell fragment stopping the sampler once the container has exited and
/// leaving the last sample (`<max> <peak> <oom> <oom_kill>`, or empty) in
/// `$__start_command_cgroup`. The cgroup can outlive the main process for a
/// moment, so it is read one last time when it still exists.
pub fn build_cgroup_sampler_stop_snippet() -> String {
    use cgroup_shell_vars::{FILE, SAMPLE, SAMPLER};
    [
        format!("kill \"${}\" 2>/dev/null", SAMPLER),
        format!("wait \"${}\" 2>/dev/null", SAMPLER),
        format!("{}=$(cat \"${}\" 2>/dev/null)", SAMPLE, FILE),
        format!("__scs_dir=$(printf '%s' \"${}\" | cut -s -d ' ' -f 5-)", SAMPLE),
        format!(
            "if [ -n \"$__scs_dir\" ] && __scs_line=$(__start_command_cgroup_read \"$__scs_dir\"); then {}=$__scs_line; fi",
            SAMPLE
        ),
        format!("rm -f \"${f}\" \"${f}.tmp\"", f = FILE),
        format!(
            "{s}=$(printf '%s' \"${s}\" | cut -d ' ' -f 1-4)",
            s = SAMPLE
        ),
    ]
    .join("; ")
}

/// Shell fragment appending the `Memory:` line of the post-mortem when a
/// sample exists. `quoted_log_path` must already be shell-quoted.
pub fn build_cgroup_memory_log_snippet(quoted_log_path: &str) -> String {
    let sample = cgroup_shell_vars::SAMPLE;
    // A function, so `$1`.. of the watcher script itself stay untouched.
    format!(
        "__start_command_cgroup_log() {{ __scm_note=''; \
         if [ \"$4\" -gt 0 ] 2>/dev/null; then __scm_note=' ({unknown})'; fi; \
         printf 'Memory:     memory.max=%s memory.peak=%s oom=%s oom_kill=%s%s\\n' \
         \"$1\" \"$2\" \"$3\" \"$4\" \"$__scm_note\"; }}; \
         if [ -n \"${sample}\" ]; then __start_command_cgroup_log ${sample} >> {log}; fi",
        unknown = OomScope::Unknown.note(),
        sample = sample,
        log = quoted_log_path,
    )
}

fn parse_counter(text: &str) -> Option<u64> {
    if !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

/// Parse a sample written by the watcher
/// (`<memory.max> <memory.peak> <oom> <oom_kill>`); `None` without a sample.
pub fn parse_cgroup_memory_sample(text: &str) -> Option<CgroupMemory> {
    let fields: Vec<&str> = text.split_whitespace().collect();
    if fields.len() < 4 {
        return None;
    }
    let counters = CgroupMemory {
        limit_bytes: parse_counter(fields[0]),
        peak_bytes: parse_counter(fields[1]),
        oom_events: parse_counter(fields[2]),
        oom_kills: parse_counter(fields[3]),
    };
    if counters.oom_events.is_none() && counters.oom_kills.is_none() {
        // memory.events was unreadable: the line carries no information.
        return None;
    }
    Some(counters)
}

/// The `Memory:` line for a sample, exactly as the watcher's shell writes it.
/// Used where Rust writes the post-mortem itself (the recovery step).
pub fn format_cgroup_memory_log_line(text: &str) -> Option<String> {
    let counters = parse_cgroup_memory_sample(text)?;
    let fields: Vec<&str> = text.split_whitespace().collect();
    let note = describe_cgroup_oom_scope(&counters)
        .map(|scope| format!(" ({})", scope.note()))
        .unwrap_or_default();
    Some(format!(
        "Memory:     memory.max={} memory.peak={} oom={} oom_kill={}{}",
        fields[0], fields[1], fields[2], fields[3], note
    ))
}

/// `Unknown` for observed kills, `None` when no kills were observed.
///
/// Separately attributed kernel/cgroup evidence would be needed to establish
/// container, parent or host scope. An unknown `oom_events` remains unknown.
pub fn describe_cgroup_oom_scope(memory: &CgroupMemory) -> Option<OomScope> {
    memory.oom_kills.filter(|kills| *kills > 0)?;
    Some(OomScope::Unknown)
}

fn format_bytes(bytes: Option<u64>) -> String {
    let Some(bytes) = bytes else {
        return "unknown".to_string();
    };
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.1} {}", value, UNITS[unit])
    }
}

/// Human-readable counters for `--status`, e.g.
/// `peak 255.9 MiB of 256.0 MiB limit, oom 0, oom_kill 3 (...)`.
pub fn format_cgroup_memory(memory: &CgroupMemory) -> String {
    let limit = match memory.limit_bytes {
        Some(_) => format!("{} limit", format_bytes(memory.limit_bytes)),
        None => "no limit".to_string(),
    };
    let count = |value: Option<u64>| value.map_or_else(|| "unknown".to_string(), |v| v.to_string());
    let note = describe_cgroup_oom_scope(memory)
        .map(|scope| format!(" ({})", scope.note()))
        .unwrap_or_default();
    format!(
        "peak {} of {}, oom {}, oom_kill {}{}",
        format_bytes(memory.peak_bytes),
        limit,
        count(memory.oom_events),
        count(memory.oom_kills),
        note
    )
}

fn counter_from_value(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|v| v.fract() == 0.0 && *v >= 0.0 && *v <= 9_007_199_254_740_991.0)
                .map(|v| v as u64)
        }),
        Value::String(text) => parse_counter(text.trim()),
        _ => None,
    }
}

/// Normalize counters read back from an execution record. Lenient, like the
/// JavaScript reader: a malformed value never makes the record unreadable.
pub fn normalize_cgroup_memory(value: &Value) -> Option<CgroupMemory> {
    let object = value.as_object()?;
    Some(CgroupMemory {
        limit_bytes: counter_from_value(object.get("limitBytes")),
        peak_bytes: counter_from_value(object.get("peakBytes")),
        oom_events: counter_from_value(object.get("oomEvents")),
        oom_kills: counter_from_value(object.get("oomKills")),
    })
}

/// `deserialize_with` helper for `ExecutionRecord::cgroup_memory`.
pub fn deserialize_cgroup_memory<'de, D>(deserializer: D) -> Result<Option<CgroupMemory>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.as_ref().and_then(normalize_cgroup_memory))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_counters_and_treats_max_as_no_limit() {
        assert_eq!(
            parse_cgroup_memory_sample("max 1024 0 2"),
            Some(CgroupMemory {
                limit_bytes: None,
                peak_bytes: Some(1024),
                oom_events: Some(0),
                oom_kills: Some(2),
            })
        );
        assert_eq!(parse_cgroup_memory_sample("max - - -"), None);
        assert_eq!(parse_cgroup_memory_sample("1 2 3"), None);
    }

    #[test]
    fn normalizes_floats_strings_and_nulls() {
        let value = serde_json::json!({
            "limitBytes": 268435456.0,
            "peakBytes": "1024",
            "oomEvents": null,
            "oomKills": -1
        });
        assert_eq!(
            normalize_cgroup_memory(&value),
            Some(CgroupMemory {
                limit_bytes: Some(268_435_456),
                peak_bytes: Some(1024),
                oom_events: None,
                oom_kills: None,
            })
        );
        assert_eq!(normalize_cgroup_memory(&Value::Null), None);
    }
}
