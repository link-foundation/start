//! Watcher-owned CPU monitor; state lives beside the execution log.
use crate::{
    cpu_penalty::{self, Config, State},
    execution_control::{CommandRunner, SystemCommandRunner},
    execution_store::{ExecutionRecord, ExecutionStore, ExecutionStoreOptions},
    store_lock::LockManager,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, thread, time::Duration};
pub fn state_path(record: &ExecutionRecord) -> PathBuf {
    PathBuf::from(format!("{}.cpu-penalty.json", record.log_path))
}
pub fn read_state(record: &ExecutionRecord) -> Option<Value> {
    if !record.options.contains_key("cpuPenaltyConfig") || record.log_path.is_empty() {
        return None;
    }
    let mut value: Value =
        serde_json::from_str(&fs::read_to_string(state_path(record)).ok()?).ok()?;
    if value["containerName"]
        != record
            .options
            .get("sessionName")
            .cloned()
            .unwrap_or(Value::Null)
        || value["attemptNumber"] != json!(record.attempt.as_ref().map(|a| a.number).unwrap_or(1))
    {
        return None;
    }
    if value["phase"] == "penalized" {
        if let Some(updated) = value["updatedAt"].as_i64() {
            let until = record
                .end_time
                .as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|s| s.timestamp_millis())
                .unwrap_or_else(|| Utc::now().timestamp_millis());
            value["penalizedMs"] =
                json!(value["penalizedMs"].as_i64().unwrap_or(0) + (until - updated).max(0));
            value["updatedAt"] = json!(until.max(updated));
        }
    }
    Some(value)
}
fn publish(
    record: &ExecutionRecord,
    state: &State,
    name: &str,
    attempt: u64,
) -> Result<(), String> {
    let file = state_path(record);
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    let mut value = serde_json::to_value(state).map_err(|e| e.to_string())?;
    value["containerName"] = json!(name);
    value["attemptNumber"] = json!(attempt);
    value["updatedAt"] = json!(Utc::now().timestamp_millis());
    let result = fs::write(&tmp, value.to_string())
        .and_then(|_| fs::rename(&tmp, &file))
        .map_err(|e| e.to_string());
    let _ = fs::remove_file(tmp);
    result
}
fn monitor(uuid: &str, name: &str, attempt: u64, standalone: Option<&str>) -> Result<(), String> {
    let store = (!uuid.is_empty()).then(|| {
        ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: std::env::var_os("START_APP_FOLDER").map(PathBuf::from),
            ..Default::default()
        })
    });
    let Some(record) = store
        .as_ref()
        .and_then(|s| s.get(uuid))
        .or_else(|| standalone.and_then(|s| serde_json::from_str::<ExecutionRecord>(s).ok()))
    else {
        return Ok(());
    };
    if record.log_path.is_empty()
        || record.options.get("sessionName").and_then(Value::as_str) != Some(name)
    {
        return Ok(());
    }
    let Some(config) = record
        .options
        .get("cpuPenaltyConfig")
        .and_then(|v| serde_json::from_value::<Config>(v.clone()).ok())
    else {
        return Ok(());
    };
    let mut lock = LockManager::new(PathBuf::from(format!(
        "{}.lock",
        state_path(&record).display()
    )));
    if !lock.acquire(100) {
        return Ok(());
    }
    let result = (|| {
        let base = crate::docker_resource_limits::normalize_resource_limits(
            record
                .options
                .get("baseResourceLimits")
                .or_else(|| record.options.get("resourceLimits")),
        );
        let base_cpus = crate::docker_resource_limits::cpu_count(&base);
        let saved = read_state(&record).and_then(|s| serde_json::from_value::<State>(s).ok());
        let mut state = cpu_penalty::initial(base_cpus, Utc::now().timestamp_millis(), saved);
        let interval =
            (config.trigger_window_ms.min(config.release_window_ms) / 8).clamp(50, 30000);
        let docker = crate::docker_cleanup::docker_command()
            .to_string_lossy()
            .into_owned();
        let runner = SystemCommandRunner;
        let started = Utc::now().timestamp_millis();
        publish(&record, &state, name, attempt)?;
        while let Some(current) = store
            .as_ref()
            .map(|s| s.get(uuid))
            .unwrap_or_else(|| Some(record.clone()))
        {
            if current.options.get("sessionName").and_then(Value::as_str) != Some(name)
                || current.attempt.as_ref().map(|a| a.number).unwrap_or(1) != attempt
            {
                break;
            }
            let live = runner.run(
                &docker,
                &[
                    "inspect".into(),
                    "-f".into(),
                    "{{.State.Running}}".into(),
                    name.into(),
                ],
            );
            if (live.success && live.stdout.trim() == "false")
                || (!live.success && Utc::now().timestamp_millis() - started > 30000)
            {
                break;
            }
            let info = runner.run(
                &docker,
                &["info".into(), "--format".into(), "{{json .}}".into()],
            );
            let stats = runner.run(
                &docker,
                &[
                    "stats".into(),
                    "--no-stream".into(),
                    "--format".into(),
                    "{{json .}}".into(),
                ],
            );
            let cpus = if info.success {
                serde_json::from_str::<Value>(&info.stdout)
                    .ok()
                    .and_then(|v| v["NCPU"].as_f64())
                    .unwrap_or(f64::NAN)
            } else {
                f64::NAN
            };
            let cores = if stats.success {
                stats
                    .stdout
                    .lines()
                    .filter_map(|s| serde_json::from_str::<Value>(s).ok())
                    .find(|v| v["Name"].as_str() == Some(name))
                    .and_then(|v| {
                        v["CPUPerc"]
                            .as_str()
                            .and_then(|s| s.strip_suffix('%'))
                            .and_then(|s| s.parse::<f64>().ok())
                    })
                    .map(|p| p / 100.0)
                    .unwrap_or(f64::NAN)
            } else {
                f64::NAN
            };
            let (mut next, action) = cpu_penalty::evaluate(
                &state,
                Utc::now().timestamp_millis(),
                cores,
                cpus,
                (interval * 3).max(5000),
                &config,
            );
            if let Some(action) = action {
                let update = runner.run(
                    &docker,
                    &[
                        vec!["update".into()],
                        crate::docker_resource_limits::cpu_update_args(&base, action.cpus),
                        vec![name.into()],
                    ]
                    .concat(),
                );
                if update.success {
                    crate::isolation::isolation_log::append_log_file(
                        &PathBuf::from(&record.log_path),
                        &format!(
                            "[start] CPU penalty {}: {} CPUs ({} of {} CPUs)\n",
                            if action.kind == "apply" {
                                "applied"
                            } else {
                                "lifted"
                            },
                            action.cpus,
                            action
                                .average
                                .map(|n| format!("{:.2}", n))
                                .unwrap_or_else(|| "capacity changed".into()),
                            action.capacity
                        ),
                    );
                } else {
                    next.phase = state.phase.clone();
                    next.since = state.since;
                    next.limit_cpus = state.limit_cpus;
                    next.penalty_count = state.penalty_count;
                    next.samples.clear();
                }
            }
            state = next;
            publish(&record, &state, name, attempt)?;
            thread::sleep(Duration::from_millis(interval as u64));
        }
        Ok(())
    })();
    lock.release();
    result
}
pub fn main(args: &[String]) {
    if args.len() < 3 {
        return;
    }
    if let Err(error) = monitor(
        &args[0],
        &args[1],
        args[2].parse().unwrap_or(1),
        args.get(3).map(String::as_str),
    ) {
        if std::env::var("START_DEBUG").as_deref() == Ok("1") {
            eprintln!("[DEBUG] CPU monitor: {}", error);
        }
    }
}
pub fn start_snippet(uuid: Option<&str>, name: &str, attempt: Option<u64>) -> String {
    use crate::isolation::isolation_log::shell_quote;
    let Some(uuid) = uuid else {
        return String::new();
    };
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "$".into());
    format!(
        "{} __start-cpu-monitor {} {} {} >/dev/null 2>&1 & __start_cpu_monitor=$!",
        shell_quote(&exe),
        shell_quote(uuid),
        shell_quote(name),
        attempt.unwrap_or(1)
    )
}
pub fn stop_snippet() -> String {
    "if [ -n \"$__start_cpu_monitor\" ]; then kill \"$__start_cpu_monitor\" 2>/dev/null; wait \"$__start_cpu_monitor\" 2>/dev/null; fi".into()
}

fn standalone_record(name: &str, options: &crate::isolation::IsolationOptions) -> Option<String> {
    let config = options.cpu_penalty_config.as_ref()?;
    let mut record = ExecutionRecord::new("CPU monitor");
    record.log_path = options.log_path.as_ref()?.to_string_lossy().into();
    record.options.insert("sessionName".into(), json!(name));
    record
        .options
        .insert("cpuPenaltyConfig".into(), json!(config));
    record
        .options
        .insert("baseResourceLimits".into(), json!(options.resource_limits));
    serde_json::to_string(&record).ok()
}
pub fn start_snippet_with_options(
    name: &str,
    options: &crate::isolation::IsolationOptions,
) -> String {
    if options.execution_id.is_some() {
        return start_snippet(options.execution_id.as_deref(), name, Some(1));
    }
    let Some(record) = standalone_record(name, options) else {
        return String::new();
    };
    let exe = std::env::current_exe().unwrap_or_default();
    use crate::isolation::isolation_log::shell_quote;
    format!(
        "{} __start-cpu-monitor '' {} 1 {} >/dev/null 2>&1 & __start_cpu_monitor=$!",
        shell_quote(&exe.to_string_lossy()),
        shell_quote(name),
        shell_quote(&record)
    )
}
pub fn spawn_standalone(name: &str, options: &crate::isolation::IsolationOptions) {
    if let (Ok(exe), Some(record)) = (std::env::current_exe(), standalone_record(name, options)) {
        let _ = std::process::Command::new(exe)
            .args(["__start-cpu-monitor", "", name, "1", &record])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}
