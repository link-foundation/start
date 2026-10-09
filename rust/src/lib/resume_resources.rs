use crate::docker_resource_limits::{normalize_resource_limits, read_docker_resource_limits};
use crate::execution_control::CommandRunner;
use crate::execution_store::ExecutionRecord;
use crate::session_probe::{SessionProbe, SessionState};
use serde_json::{json, Value};

pub fn restore_base_cpu(mut limits: Vec<String>, record: &ExecutionRecord) -> Vec<String> {
    if record.options.contains_key("cpuPenaltyConfig") {
        let base = normalize_resource_limits(
            record
                .options
                .get("baseResourceLimits")
                .or_else(|| record.options.get("resourceLimits")),
        );
        let cpu = |s: &String| {
            s.starts_with("--cpus=")
                || s.starts_with("--cpu-quota=")
                || s.starts_with("--cpu-period=")
        };
        limits.retain(|s| !cpu(s));
        limits.extend(base.into_iter().filter(cpu));
    }
    limits
}

#[allow(clippy::type_complexity)]
pub fn prepare<R: CommandRunner>(
    record: &ExecutionRecord,
    probe: &SessionProbe,
    overrides: &Value,
    runner: &R,
) -> Result<(Option<Vec<String>>, Option<Value>, Value), String> {
    if record.options.get("isolated").and_then(Value::as_str) != Some("docker") {
        if ["memory", "memorySwap", "cpus"]
            .iter()
            .any(|k| overrides.get(k).and_then(Value::as_str).is_some())
        {
            return Err("Resource overrides require a Docker execution".into());
        }
        return Ok((None, None, Value::Null));
    }
    let live = if probe.state == SessionState::Stopped {
        record
            .options
            .get("sessionName")
            .and_then(Value::as_str)
            .and_then(|name| read_docker_resource_limits(name, runner))
    } else {
        None
    };
    let base = restore_base_cpu(
        live.unwrap_or_else(|| normalize_resource_limits(record.options.get("resourceLimits"))),
        record,
    );
    let old_memory = base
        .iter()
        .find_map(|s| {
            s.strip_prefix("--memory=")
                .and_then(|s| crate::docker_resource_options::parse_spec(s, false).ok())
                .map(|v| json!(v.0 as u64))
        })
        .unwrap_or(json!("unlimited"));
    let (mut limits, values) = crate::docker_resource_options::resolve(
        overrides,
        &base,
        runner,
        crate::docker_resource_options::random_fraction,
    )?;
    if overrides.get("cpus").and_then(Value::as_str).is_some()
        && probe.state == SessionState::Stopped
    {
        // Preserve the existing CPU representation for an in-place update.
        let cpu =
            crate::docker_resource_limits::with_cpu_limit(base, values["cpus"].as_f64().unwrap());
        let is_cpu = |s: &String| {
            ["--cpus=", "--cpu-quota=", "--cpu-period="]
                .iter()
                .any(|p| s.starts_with(p))
        };
        limits.retain(|s| !is_cpu(s));
        limits.extend(cpu.into_iter().filter(is_cpu));
    }
    if record.options.contains_key("cpuPenaltyConfig")
        && overrides.get("cpus").and_then(Value::as_str).is_none()
    {
        limits = clamp_cpu_to_daemon(limits, runner)?;
    }
    let mut resolved = record
        .options
        .get("resolvedLimits")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    for (k, v) in values.as_object().unwrap() {
        resolved[k] = v.clone();
    }
    if record.options.contains_key("cpuPenaltyConfig") {
        if let Some(cpu) = crate::docker_resource_limits::cpu_count(&limits) {
            resolved["cpus"] = json!(cpu);
        }
    }

    Ok((Some(limits), Some(resolved), old_memory))
}

pub fn clamp_cpu_to_daemon<R: CommandRunner + ?Sized>(
    limits: Vec<String>,
    runner: &R,
) -> Result<Vec<String>, String> {
    let info = runner.run(
        &crate::docker_cleanup::docker_command().to_string_lossy(),
        &["info".into(), "--format".into(), "{{json .}}".into()],
    );
    let capacity = info
        .success
        .then(|| serde_json::from_str::<Value>(&info.stdout).ok())
        .flatten()
        .and_then(|v| v["NCPU"].as_f64())
        .filter(|n| *n > 0.0)
        .ok_or("Cannot restore base CPU capacity")?;
    let base = crate::docker_resource_limits::cpu_count(&limits).unwrap_or(capacity);
    Ok(crate::docker_resource_limits::with_cpu_limit(
        limits,
        base.min(capacity),
    ))
}
