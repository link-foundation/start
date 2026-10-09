//! Resolve launch/resume resource specs using Docker daemon capacity, never local RAM.
use crate::args_parser::WrapperOptions;
use crate::docker_cleanup::docker_command;
use crate::execution_control::CommandRunner;
use serde_json::{json, Value};

pub fn parse_spec(text: &str, cpu: bool) -> Result<(f64, f64, bool), String> {
    let text = text.trim().to_lowercase();
    let invalid = || format!("Invalid resource limit: {}", text);
    if text.contains('%') {
        let parts = text.split('-').collect::<Vec<_>>();
        if parts.is_empty() || parts.len() > 2 {
            return Err(invalid());
        }
        let values = parts
            .iter()
            .map(|s| {
                s.strip_suffix('%')
                    .ok_or_else(invalid)?
                    .parse::<f64>()
                    .map_err(|_| invalid())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let min = values[0];
        let max = *values.last().unwrap();
        return if min.is_finite() && max.is_finite() && min > 0.0 && max <= 100.0 && min <= max {
            Ok((min, max, true))
        } else {
            Err(invalid())
        };
    }
    let end = text
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(text.len());
    let number = text[..end].parse::<f64>().map_err(|_| invalid())?;
    let suffix = &text[end..];
    let multiplier = match suffix {
        "" | "b" => 1.0,
        "k" | "kb" => 1024.0,
        "m" | "mb" => 1024.0_f64.powi(2),
        "g" | "gb" => 1024.0_f64.powi(3),
        "t" | "tb" => 1024.0_f64.powi(4),
        _ => return Err(invalid()),
    };
    let amount = number * multiplier;
    if (cpu && !suffix.is_empty())
        || !amount.is_finite()
        || amount <= 0.0
        || amount > 9007199254740991.0
    {
        return Err(invalid());
    }
    Ok((amount, amount, false))
}

pub fn parse(args: &[String], index: usize, options: &mut WrapperOptions) -> Result<usize, String> {
    let arg = &args[index];
    let (flag, inline) = arg
        .split_once('=')
        .map(|(f, v)| (f, Some(v)))
        .unwrap_or((arg, None));
    let target = match flag {
        "--memory" => &mut options.memory,
        "--memory-swap" => &mut options.memory_swap,
        "--cpus" => &mut options.cpus,
        "--on-kill-resume-memory" => &mut options.on_kill_resume_memory,
        _ => return Ok(0),
    };
    let value = inline
        .or_else(|| args.get(index + 1).map(String::as_str))
        .filter(|v| !v.is_empty() && !v.starts_with('-'))
        .ok_or_else(|| format!("Option {} requires a resource limit", flag))?;
    parse_spec(value, flag == "--cpus")?;
    *target = Some(value.into());
    Ok(if inline.is_some() { 1 } else { 2 })
}

pub fn validate(options: &WrapperOptions) -> Result<(), String> {
    if options.memory.is_none()
        && options.memory_swap.is_none()
        && options.cpus.is_none()
        && options.on_kill_resume_memory.is_none()
    {
        return Ok(());
    }
    if options.resume.is_none() && options.isolated.as_deref() != Some("docker") {
        return Err("Resource options require Docker isolation or --resume".into());
    }
    if options.memory_swap.is_some() && options.memory.is_none() && options.resume.is_none() {
        return Err("--memory-swap requires --memory".into());
    }
    if options.on_kill_resume_memory.is_some()
        && options.on_kill_resume.is_none()
        && options.recovery_command.is_none()
    {
        return Err(
            "--on-kill-resume-memory requires --on-kill-resume or --recovery-command".into(),
        );
    }
    Ok(())
}

pub fn random_fraction() -> f64 {
    (uuid::Uuid::new_v4().as_u128() as u64 & ((1_u64 << 53) - 1)) as f64 / (1_u64 << 53) as f64
}

pub fn resolve<R: CommandRunner + ?Sized>(
    specs: &Value,
    base: &[String],
    runner: &R,
    random: impl Fn() -> f64,
) -> Result<(Vec<String>, Value), String> {
    let mut parsed = Vec::new();
    for field in ["memory", "memorySwap", "cpus"] {
        if let Some(value) = specs.get(field).and_then(Value::as_str) {
            parsed.push((field, parse_spec(value, field == "cpus")?));
        }
    }
    let capacity = if parsed.iter().any(|(_, s)| s.2) {
        let info = runner.run(
            &docker_command().to_string_lossy(),
            &["info".into(), "--format".into(), "{{json .}}".into()],
        );
        if !info.success {
            return Err("Cannot read resource capacity from Docker daemon".into());
        }
        serde_json::from_str::<Value>(&info.stdout).map_err(|e| e.to_string())?
    } else {
        Value::Null
    };
    let mut values = json!({});
    let mut limits = base.to_vec();
    for (field, (min, max, percent)) in parsed {
        let amount = if percent {
            capacity
                .get(if field == "cpus" { "NCPU" } else { "MemTotal" })
                .and_then(Value::as_f64)
                .filter(|n| *n > 0.0)
                .ok_or("Docker daemon did not report MemTotal/NCPU")?
                * (min + (max - min) * random())
                / 100.0
        } else {
            min
        };
        let amount = if field == "cpus" {
            (amount * 1e9).floor() / 1e9
        } else {
            amount.floor()
        };
        if amount
            < if field == "cpus" {
                0.01
            } else {
                6.0 * 1024.0 * 1024.0
            }
        {
            return Err(format!("Resolved {} is below Docker's minimum", field));
        }
        values[field] = if field == "cpus" {
            json!(amount)
        } else {
            json!(amount as u64)
        };
    }
    if values.get("memory").is_some() && values.get("memorySwap").is_none() {
        values["memorySwap"] = values["memory"].clone();
    }
    let memory = values.get("memory").and_then(Value::as_f64).or_else(|| {
        limits
            .iter()
            .find_map(|s| s.strip_prefix("--memory="))
            .and_then(|s| parse_spec(s, false).ok())
            .map(|s| s.0)
    });
    if let Some(swap) = values.get("memorySwap").and_then(Value::as_f64) {
        if memory.is_none_or(|m| swap < m) {
            return Err("memory-swap must be at least memory".into());
        }
    }
    for field in ["memory", "memorySwap", "cpus"] {
        if let Some(value) = values.get(field) {
            let flag = if field == "memorySwap" {
                "--memory-swap"
            } else if field == "memory" {
                "--memory"
            } else {
                "--cpus"
            };
            limits.retain(|s| {
                !s.starts_with(&format!("{}=", flag))
                    && !(field == "cpus"
                        && (s.starts_with("--cpu-quota=") || s.starts_with("--cpu-period=")))
            });
            limits.push(format!("{}={}", flag, value.as_f64().unwrap()));
        }
    }
    Ok((limits, values))
}

pub fn specs(options: &WrapperOptions) -> Value {
    json!({"memory":options.memory,"memorySwap":options.memory_swap,"cpus":options.cpus})
}

pub fn prepare(options: &mut WrapperOptions) -> Result<(), String> {
    let (limits, values) = resolve(
        &specs(options),
        &options.resource_limits,
        &crate::execution_control::SystemCommandRunner,
        random_fraction,
    )?;
    options.resource_limits = limits;
    options.resolved_limits = values;
    Ok(())
}

pub fn log_line(specs: &Value, values: &Value) -> Option<String> {
    let entries = values.as_object()?;
    if entries.is_empty() {
        return None;
    }
    Some(format!(
        "Limits: {}",
        entries
            .iter()
            .map(|(k, v)| format!(
                "{}={} ({} -> {})",
                k,
                v,
                specs.get(k).and_then(Value::as_str).unwrap_or("default"),
                v
            ))
            .collect::<Vec<_>>()
            .join(" ")
    ))
}
