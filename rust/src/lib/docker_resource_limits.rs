//! Docker resource limits that must survive a resume (issue #176).
//!
//! `docker commit` captures a container's filesystem and image config, but not
//! its HostConfig. A snapshot-based resume (`$ --resume <id> -- <cmd>`) used to
//! start the replacement container without the memory, CPU and PIDs limits the
//! original one had — limits a supervisor typically applied with
//! `docker update`, so they were never part of the stored launch options.
//!
//! This module reads the limits back out of `docker inspect` and translates the
//! non-default ones into `docker run` flags. The flags are kept in the
//! `--flag=value` form, so the same list is stored in the execution record,
//! shown in `[Isolation]` status lines, and spliced into `docker run` as is.

use serde_json::Value;

use crate::docker_cleanup::docker_command;
use crate::execution_control::CommandRunner;

/// Docker's default `/dev/shm` size; only a different size is re-applied.
pub const DEFAULT_SHM_SIZE: i64 = 64 * 1024 * 1024;

const KIB: i64 = 1024;
const MIB: i64 = KIB * 1024;
const GIB: i64 = MIB * 1024;

/// Format a byte count with the largest binary unit `docker run` accepts that
/// represents it exactly (`268435456` → `256m`).
pub fn format_docker_bytes(bytes: i64) -> String {
    for (unit, size) in [("g", GIB), ("m", MIB), ("k", KIB)] {
        if bytes >= size && bytes % size == 0 {
            return format!("{}{}", bytes / size, unit);
        }
    }
    bytes.to_string()
}

/// Format `NanoCpus` as the decimal `--cpus` value (`500000000` → `0.5`).
pub fn format_docker_cpus(nano_cpus: i64) -> String {
    let text = format!("{:.9}", nano_cpus as f64 / 1e9);
    let text = text.trim_end_matches('0').trim_end_matches('.');
    text.to_string()
}

fn number(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn positive(value: Option<&Value>) -> Option<i64> {
    number(value).filter(|n| *n > 0)
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn scalar_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// Translate an inspected `HostConfig` into `docker run` flags.
///
/// Only limits that differ from Docker's defaults are emitted, and only in
/// combinations `docker run` accepts: `--memory-swap` needs `--memory`, and
/// `--cpus` cannot be combined with `--cpu-quota`/`--cpu-period`.
pub fn parse_docker_resource_limits(host_config: &Value) -> Vec<String> {
    let Some(h) = host_config.as_object() else {
        return Vec::new();
    };
    let mut limits = Vec::new();

    if let Some(memory) = positive(h.get("Memory")) {
        limits.push(format!("--memory={}", format_docker_bytes(memory)));
        match number(h.get("MemorySwap")) {
            Some(-1) => limits.push("--memory-swap=-1".to_string()),
            Some(swap) if swap > 0 => {
                limits.push(format!("--memory-swap={}", format_docker_bytes(swap)))
            }
            _ => {}
        }
    }
    if let Some(reservation) = positive(h.get("MemoryReservation")) {
        limits.push(format!(
            "--memory-reservation={}",
            format_docker_bytes(reservation)
        ));
    }

    if let Some(nano_cpus) = positive(h.get("NanoCpus")) {
        limits.push(format!("--cpus={}", format_docker_cpus(nano_cpus)));
    } else {
        if let Some(quota) = positive(h.get("CpuQuota")) {
            limits.push(format!("--cpu-quota={}", quota));
        }
        if let Some(period) = positive(h.get("CpuPeriod")) {
            limits.push(format!("--cpu-period={}", period));
        }
    }
    if let Some(shares) = positive(h.get("CpuShares")) {
        limits.push(format!("--cpu-shares={}", shares));
    }
    if let Some(cpus) = non_empty(h.get("CpusetCpus")) {
        limits.push(format!("--cpuset-cpus={}", cpus));
    }
    if let Some(mems) = non_empty(h.get("CpusetMems")) {
        limits.push(format!("--cpuset-mems={}", mems));
    }

    if let Some(pids) = positive(h.get("PidsLimit")) {
        limits.push(format!("--pids-limit={}", pids));
    }

    if let Some(shm) = positive(h.get("ShmSize")) {
        if shm != DEFAULT_SHM_SIZE {
            limits.push(format!("--shm-size={}", format_docker_bytes(shm)));
        }
    }

    if let Some(storage) = h.get("StorageOpt").and_then(Value::as_object) {
        let mut keys: Vec<&String> = storage.keys().collect();
        keys.sort();
        for key in keys {
            let value = scalar_text(storage.get(key));
            if !value.trim().is_empty() {
                limits.push(format!("--storage-opt={}={}", key, value.trim()));
            }
        }
    }

    if let Some(ulimits) = h.get("Ulimits").and_then(Value::as_array) {
        for ulimit in ulimits {
            if let Some(name) = non_empty(ulimit.get("Name")) {
                limits.push(format!(
                    "--ulimit={}={}:{}",
                    name,
                    scalar_text(ulimit.get("Soft")),
                    scalar_text(ulimit.get("Hard"))
                ));
            }
        }
    }

    limits
}

/// Read a container's resource limits with `docker inspect`.
///
/// Returns `None` when the container could not be read.
pub fn read_docker_resource_limits<R: CommandRunner + ?Sized>(
    container_name: &str,
    runner: &R,
) -> Option<Vec<String>> {
    let docker = docker_command().to_string_lossy().to_string();
    let args: Vec<String> = [
        "inspect",
        "--format",
        "{{json .HostConfig}}",
        container_name,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let result = runner.run(&docker, &args);
    if !result.success {
        return None;
    }
    let host_config: Value = serde_json::from_str(result.stdout.trim()).ok()?;
    Some(parse_docker_resource_limits(&host_config))
}

/// Normalize a stored `resourceLimits` value (array or whitespace-separated
/// string) to a list of flags.
pub fn normalize_resource_limits(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .filter(|flag| flag.starts_with("--"))
            .collect(),
        Some(Value::String(text)) => text
            .split_whitespace()
            .filter(|flag| flag.starts_with("--"))
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// `[Isolation]` status line for resource limits, or `None` when there are none.
pub fn build_resource_limits_status_line(limits: &[String]) -> Option<String> {
    if limits.is_empty() {
        None
    } else {
        Some(format!("[Isolation] Resource limits: {}", limits.join(" ")))
    }
}
