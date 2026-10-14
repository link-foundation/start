//! Watcher-owned CPU monitor; state lives beside the execution log.
use crate::{
    cpu_penalty::{self, Config, State},
    execution_control::{CommandRunner, SystemCommandRunner},
    execution_store::{ExecutionRecord, ExecutionStore, ExecutionStoreOptions},
    store_lock::LockManager,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
static STOP: AtomicBool = AtomicBool::new(false);
const STOP_POLL: Duration = Duration::from_millis(50);
#[cfg(unix)]
extern "C" fn stop_monitor(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
/// `thread::sleep` resumes after EINTR, so a handler that only sets `STOP`
/// would wait out the whole tick; short slices lift the cap promptly.
fn sleep_until_stopped(interval: Duration) {
    let started = Instant::now();
    while !STOP.load(Ordering::Relaxed) {
        let Some(rest) = interval.checked_sub(started.elapsed()) else {
            break;
        };
        thread::sleep(rest.min(STOP_POLL));
    }
}
fn debug(record: &ExecutionRecord, error: &str) {
    if std::env::var("START_DEBUG").as_deref() == Ok("1") {
        let text = format!("[DEBUG] CPU monitor: {}\n", error);
        eprint!("{}", text);
        crate::isolation::isolation_log::append_log_file(&PathBuf::from(&record.log_path), &text);
    }
}
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
        || record.attempt.as_ref().map(|a| a.number).unwrap_or(1) != attempt
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
    )))
    .for_cpu_monitor();
    if !lock.acquire(100) {
        return Ok(());
    }
    let result = (|| {
        let mut base = crate::docker_resource_limits::normalize_resource_limits(
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
        while !STOP.load(Ordering::Relaxed) {
            let tick = (|| -> Result<bool, String> {
                let Some(current) = store
                    .as_ref()
                    .map(|s| s.get(uuid))
                    .unwrap_or_else(|| Some(record.clone()))
                else {
                    return Ok(false);
                };
                if current.options.get("sessionName").and_then(Value::as_str) != Some(name)
                    || current.attempt.as_ref().map(|a| a.number).unwrap_or(1) != attempt
                {
                    return Ok(false);
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
                    || (!live.success
                        && (live.stderr.contains("No such object")
                            || live.stderr.contains("No such container")))
                {
                    return Ok(false);
                }
                let observed =
                    crate::docker_resource_limits::read_docker_resource_limits(name, &runner);
                if let Some(limits) = observed.as_ref() {
                    base = limits.clone();
                    state = cpu_penalty::observe_base(
                        &state,
                        crate::docker_resource_limits::cpu_count(limits),
                        Utc::now().timestamp_millis(),
                    );
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
                let cores = if stats.success && live.success && observed.is_some() {
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
                debug(
                    &record,
                    &format!(
                        "sample: phase={} base={:?} limit={:?} cores={} daemon={}",
                        state.phase, state.base_cpus, state.limit_cpus, cores, cpus
                    ),
                );
                let (mut next, action) = cpu_penalty::evaluate(
                    &state,
                    Utc::now().timestamp_millis(),
                    cores,
                    cpus,
                    (interval * 3).max(5000),
                    &config,
                );
                if let Some(action) = action {
                    if action.kind == "apply" {
                        publish(&record, &next, name, attempt)?;
                    }
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
                            &format!("{}\n", cpu_penalty::transition_log(&action, &config)),
                        );
                    } else {
                        debug(&record, &format!("docker update failed: {}", update.stderr));
                        next.phase = state.phase.clone();
                        next.since = state.since;
                        next.limit_cpus = state.limit_cpus;
                        next.penalty_count = state.penalty_count;
                        next.samples.clear();
                    }
                }
                state = next;
                publish(&record, &state, name, attempt)?;
                Ok(true)
            })();
            match tick {
                Ok(false) => break,
                Ok(true) => {}
                Err(error) => {
                    state.samples.clear();
                    debug(&record, &format!("tick failed: {}", error));
                }
            }
            sleep_until_stopped(Duration::from_millis(interval as u64));
        }
        let current = store
            .as_ref()
            .map(|s| s.get(uuid))
            .unwrap_or_else(|| Some(record.clone()));
        if state.phase == "penalized"
            && current.is_some_and(|r| {
                r.options.get("sessionName").and_then(Value::as_str) == Some(name)
                    && r.attempt.as_ref().map(|a| a.number).unwrap_or(1) == attempt
            })
        {
            let live = runner.run(
                &docker,
                &[
                    "inspect".into(),
                    "-f".into(),
                    "{{.State.Running}}".into(),
                    name.into(),
                ],
            );
            if live.success && live.stdout.trim() == "true" {
                if let Some(limits) =
                    crate::docker_resource_limits::read_docker_resource_limits(name, &runner)
                {
                    if crate::docker_resource_limits::cpu_count(&limits) == state.limit_cpus {
                        let base_limits = if let Some(base) = state.base_cpus {
                            crate::docker_resource_limits::with_cpu_limit(limits.clone(), base)
                        } else {
                            limits
                                .iter()
                                .filter(|s| {
                                    !["--cpus=", "--cpu-quota=", "--cpu-period="]
                                        .iter()
                                        .any(|p| s.starts_with(p))
                                })
                                .cloned()
                                .collect()
                        };
                        let restore =
                            crate::resume_resources::clamp_cpu_to_daemon(base_limits, &runner)?;
                        let cpus = crate::docker_resource_limits::cpu_count(&restore)
                            .ok_or("Cannot restore CPU base")?;
                        let update = runner.run(
                            &docker,
                            &[
                                vec!["update".into()],
                                crate::docker_resource_limits::cpu_update_args(&limits, cpus),
                                vec![name.into()],
                            ]
                            .concat(),
                        );
                        if update.success {
                            let now = Utc::now().timestamp_millis();
                            cpu_penalty::accrue(&mut state, now);
                            state.phase = "observing".into();
                            state.limit_cpus = Some(cpus);
                            state.since = now;
                            crate::isolation::isolation_log::append_log_file(
                                &PathBuf::from(&record.log_path),
                                &format!(
                                    "[start] CPU penalty lifted: {} CPUs (monitor stopped)\n",
                                    cpus
                                ),
                            );
                            if let Err(error) = publish(&record, &state, name, attempt) {
                                debug(&record, &error);
                            }
                        }
                    }
                }
            }
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
    STOP.store(false, Ordering::Relaxed);
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGTERM, stop_monitor as *const () as usize);
        libc::signal(libc::SIGINT, stop_monitor as *const () as usize);
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
        std::process::exit(1);
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
    supervise_snippet(&format!(
        "{} __start-cpu-monitor {} {} {}",
        shell_quote(&exe),
        shell_quote(uuid),
        shell_quote(name),
        attempt.unwrap_or(1)
    ))
}
fn supervise_snippet(command: &str) -> String {
    format!("( __start_cpu_child=; trap 'if [ -n \"$__start_cpu_child\" ]; then kill \"$__start_cpu_child\" 2>/dev/null; wait \"$__start_cpu_child\" 2>/dev/null; fi; exit 0' TERM INT HUP; while :; do {} >/dev/null 2>&1 & __start_cpu_child=$!; wait \"$__start_cpu_child\"; __start_cpu_code=$?; [ \"$__start_cpu_code\" -eq 0 ] && break; sleep 1 & __start_cpu_child=$!; wait \"$__start_cpu_child\"; done ) & __start_cpu_monitor=$!", command)
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
    supervise_snippet(&format!(
        "{} __start-cpu-monitor '' {} 1 {}",
        shell_quote(&exe.to_string_lossy()),
        shell_quote(name),
        shell_quote(&record)
    ))
}
pub fn spawn_standalone(name: &str, options: &crate::isolation::IsolationOptions) {
    let snippet = start_snippet_with_options(name, options);
    if !snippet.is_empty() {
        let _ = std::process::Command::new("sh")
            .args(["-c", &snippet])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}
