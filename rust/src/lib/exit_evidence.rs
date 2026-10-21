//! Exit-time evidence; cumulative cgroup counters and OOMKilled are historical.
use crate::execution_control::{CommandRunner, SystemCommandRunner};
use chrono::{DateTime, Duration};
pub const MAIN_OOM: &str = "Exit evidence: main-oom (recent cgroup oom_kill delta)";
pub const DOCKER_OOM: &str = "Exit evidence: main-oom (recent Docker oom event)";
pub const DAEMON_RESTART: &str = "Exit evidence: docker-daemon-restart (Docker service journal)";
pub const DAEMON_RESTART_API: &str =
    "Exit evidence: docker-daemon-restart (Docker API: containers finished together)";
const DAEMON_RESTART_PREFIX: &str = "Exit evidence: docker-daemon-restart";
const UNAVAILABLE: &str =
    "Exit evidence: unavailable (no attributed exit-time OOM or daemon restart evidence)";
// dockerd gives every container its stop timeout and kills the rest within its
// 15 s shutdown timeout, so the containers of one restart finish this close.
const DAEMON_RESTART_WINDOW_MS: i64 = 15_000;
const CONTAINER_STATE_FORMAT: &str =
    "{{.Id}} {{.State.FinishedAt}} {{.State.StartedAt}} {{.State.ExitCode}} {{.State.OOMKilled}}";
// Bounds one `docker inspect` call on hosts with many stopped containers.
const MAX_PEER_CONTAINERS: usize = 256;

fn is_container_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn recent_oom_delta(sample: &str, finished_at: &str) -> bool {
    let fields = sample.split_whitespace().collect::<Vec<_>>();
    let changed = fields.get(4).and_then(|s| s.parse::<i64>().ok());
    let observed = fields.get(5).and_then(|s| s.parse::<i64>().ok());
    match (
        changed,
        observed,
        DateTime::parse_from_rfc3339(finished_at).ok(),
    ) {
        (Some(changed), Some(observed), Some(finished)) => {
            changed > 0
                && changed <= observed
                && finished.timestamp().abs_diff(changed) <= 3
                && finished.timestamp().abs_diff(observed) <= 3
        }
        _ => false,
    }
}

pub fn from_log(log: Option<&str>) -> (bool, bool) {
    let last = last_marker(log);
    (
        last == Some(MAIN_OOM) || last == Some(DOCKER_OOM),
        last.is_some_and(|s| s.starts_with(DAEMON_RESTART_PREFIX)),
    )
}

fn last_marker(log: Option<&str>) -> Option<&str> {
    log.unwrap_or("")
        .lines()
        .rfind(|s| s.starts_with("Exit evidence:"))
}

/// Which source attributed the restart: the host journal or the API (#241).
pub fn daemon_restart_source(log: Option<&str>) -> Option<&'static str> {
    match last_marker(log) {
        Some(DAEMON_RESTART_API) => Some("api"),
        Some(s) if s.starts_with(DAEMON_RESTART_PREFIX) => Some("journal"),
        _ => None,
    }
}

/// The stored `exitEvidence` object; the source is kept only for a restart.
pub fn evidence_json(log: Option<&str>, main_oom: bool) -> serde_json::Value {
    let (_, daemon) = from_log(log);
    let mut value = serde_json::json!({"mainOom": main_oom, "daemonRestart": daemon});
    if let Some(source) = daemon_restart_source(log).filter(|_| daemon) {
        value["daemonRestartSource"] = source.into();
    }
    value
}

/// Socket-only daemon-restart evidence (issue #241): another container that
/// finished within the same shutdown window, was not OOM-killed, and was either
/// stopped by a signal (137/143) or started again afterwards (restart policy;
/// moby resets its ExitCode to 0 but keeps FinishedAt). `docker events` cannot
/// be used: its buffer does not survive the restart, while State does.
pub fn daemon_restart_api_evidence(states: &str, container_id: &str, finished_at: &str) -> bool {
    let Ok(finished) = DateTime::parse_from_rfc3339(finished_at) else {
        return false;
    };
    let finished = finished.timestamp_millis();
    states.lines().any(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let [id, peer_finished, peer_started, exit, oom] = fields[..] else {
            return false;
        };
        let Ok(end) = DateTime::parse_from_rfc3339(peer_finished) else {
            return false;
        };
        let end = end.timestamp_millis();
        if !is_container_id(id)
            || id == container_id
            || oom != "false"
            || end <= 0
            || (end - finished).abs() > DAEMON_RESTART_WINDOW_MS
        {
            return false;
        }
        exit == "137"
            || exit == "143"
            || DateTime::parse_from_rfc3339(peer_started)
                .is_ok_and(|started| started.timestamp_millis() > end)
    })
}

pub fn recent_docker_oom(events: &str, finished_at: &str) -> bool {
    let Ok(finished) = DateTime::parse_from_rfc3339(finished_at) else {
        return false;
    };
    let finished = finished.timestamp_millis() as f64 / 1000.0;
    events.lines().any(|line| {
        let line = line.trim();
        !line.is_empty()
            && line.bytes().all(|c| c.is_ascii_digit())
            && line.parse::<u64>().is_ok_and(|at| {
                let gap = finished - at as f64;
                at > 0 && (-1.0..=3.0).contains(&gap)
            })
    })
}

/// Terminal evidence remains useful if the user moves or truncates the log.
pub fn record_tail(
    record: &crate::execution_store::ExecutionRecord,
    tail: Option<String>,
) -> Option<String> {
    let stored = record
        .options
        .get("exitEvidence")
        .filter(|value| value.is_object());
    let marker = if stored
        .and_then(|s| s.get("daemonRestart"))
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        if stored
            .and_then(|s| s.get("daemonRestartSource"))
            .and_then(serde_json::Value::as_str)
            == Some("api")
        {
            Some(DAEMON_RESTART_API)
        } else {
            Some(DAEMON_RESTART)
        }
    } else if stored
        .and_then(|s| s.get("mainOom"))
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        Some(MAIN_OOM)
    } else if stored.is_some() {
        Some(UNAVAILABLE)
    } else {
        None
    };
    marker
        .map(|marker| format!("{}\n{}\n", tail.as_deref().unwrap_or(""), marker))
        .or(tail)
}

pub fn daemon_restart_evidence(journal: &str, container_id: &str) -> bool {
    !container_id.is_empty()
        && journal.lines().any(|s| {
            [
                "Main process exited",
                "Stopping Docker",
                "Starting Docker",
                "Daemon shutdown complete",
            ]
            .iter()
            .any(|m| s.contains(m))
        })
        && journal.lines().any(|s| {
            s.contains(container_id)
                && ["failed to exit", "using the force", "force kill"]
                    .iter()
                    .any(|m| s.contains(m))
        })
}

pub fn collect<R: CommandRunner>(
    name: &str,
    sample: &str,
    finished: &str,
    exit: &str,
    oom: &str,
    runner: &R,
) -> String {
    let local = std::env::var("DOCKER_HOST")
        .map(|s| s.starts_with("unix://"))
        .unwrap_or(true);
    let sampled_oom = oom == "true"
        && (exit == "137" || exit.parse::<i32>().is_ok_and(|n| n < 0))
        && recent_oom_delta(sample, finished);
    if exit == "137" && !name.is_empty() {
        if let Ok(end) = DateTime::parse_from_rfc3339(finished) {
            let id = runner.run(
                &crate::docker_cleanup::docker_command().to_string_lossy(),
                &["inspect".into(), "-f".into(), "{{.Id}}".into(), name.into()],
            );
            let id_text = id.stdout.trim();
            if id.success && is_container_id(id_text) {
                let journal = if local {
                    runner.run(
                        "journalctl",
                        &[
                            "-u".into(),
                            "docker.service".into(),
                            "--since".into(),
                            (end - Duration::seconds(60)).to_rfc3339(),
                            "--until".into(),
                            (end + Duration::seconds(1)).to_rfc3339(),
                            "--no-pager".into(),
                            "-o".into(),
                            "cat".into(),
                        ],
                    )
                } else {
                    Default::default()
                };
                if journal.success && daemon_restart_evidence(&journal.stdout, id_text) {
                    return DAEMON_RESTART.into();
                }
                let events = runner.run(
                    &crate::docker_cleanup::docker_command().to_string_lossy(),
                    &[
                        "events".into(),
                        "--since".into(),
                        (end - Duration::seconds(60)).to_rfc3339(),
                        "--until".into(),
                        (end + Duration::seconds(1)).to_rfc3339(),
                        "--filter".into(),
                        format!("container={}", id_text),
                        "--filter".into(),
                        "event=oom".into(),
                        "--format".into(),
                        "{{.Time}}".into(),
                    ],
                );
                if events.success && recent_docker_oom(&events.stdout, finished) {
                    return DOCKER_OOM.into();
                }
                // Without a host journal (a mounted docker.sock, a remote
                // daemon) the only record of the restart is the state of the
                // other containers.
                let docker = crate::docker_cleanup::docker_command()
                    .to_string_lossy()
                    .into_owned();
                let peers = if sampled_oom {
                    Default::default()
                } else {
                    runner.run(
                        &docker,
                        &["ps".into(), "-a".into(), "-q".into(), "--no-trunc".into()],
                    )
                };
                let ids = peers
                    .stdout
                    .split_whitespace()
                    .filter(|peer| is_container_id(peer) && *peer != id_text)
                    .take(MAX_PEER_CONTAINERS)
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                // A container removed after `docker ps` fails inspect with
                // status 1 but the others are still printed, so the output is
                // used either way.
                let states = if ids.is_empty() {
                    Default::default()
                } else {
                    let mut args =
                        vec!["inspect".into(), "-f".into(), CONTAINER_STATE_FORMAT.into()];
                    args.extend(ids.iter().cloned());
                    runner.run(&docker, &args)
                };
                if daemon_restart_api_evidence(&states.stdout, id_text, finished) {
                    return DAEMON_RESTART_API.into();
                }
                if std::env::var("START_DEBUG").as_deref() == Ok("1") {
                    eprintln!("[DEBUG] Exit evidence: container={} finishedAt={} eventsAvailable={} oomEvents={:?} peerContainers={} peerStates={:?} sample={:?}", id_text, finished, events.success, events.stdout, ids.len(), states.stdout, sample);
                }
            }
        }
    }
    if sampled_oom {
        return MAIN_OOM.into();
    }
    UNAVAILABLE.into()
}

/// A watcher that shares the daemon with its task (a mounted docker.sock) dies
/// in the same restart and never logs evidence, so `--status` collects it from
/// the container state that survived, once per process (issue #241).
pub fn collect_lost_watcher_evidence<R: CommandRunner>(
    record: &crate::execution_store::ExecutionRecord,
    finished_at: &str,
    oom_killed: Option<bool>,
    runner: &R,
) -> Option<serde_json::Value> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, serde_json::Value>>> = OnceLock::new();
    let name = record
        .options
        .get("sessionName")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())?;
    if record.options.contains_key("exitEvidence") || finished_at.is_empty() {
        return None;
    }
    let key = format!("{}\0{}", name, finished_at);
    let cache = CACHE.get_or_init(Default::default);
    if let Some(value) = cache.lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Some(value);
    }
    let oom = match oom_killed {
        Some(true) => "true",
        Some(false) => "false",
        None => "",
    };
    let line = collect(name, "", finished_at, "137", oom, runner);
    let (main, _) = from_log(Some(&line));
    let value = evidence_json(Some(&line), main);
    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, value.clone());
    }
    Some(value)
}

/// Stores the lost watcher's evidence when the log tail carries none.
pub(crate) fn add_lost_watcher_evidence(
    enriched: &mut crate::execution_store::ExecutionRecord,
    record: &crate::execution_store::ExecutionRecord,
    state: Option<&crate::status_probe::DockerState>,
    tail: Option<&str>,
) {
    let logged = tail.is_some_and(|tail| tail.lines().any(|l| l.starts_with("Exit evidence:")));
    if let Some(evidence) = state
        .filter(|_| !logged)
        .and_then(|state| state.lost_watcher_evidence(record))
    {
        enriched.options.insert("exitEvidence".into(), evidence);
    }
}

pub fn main(args: &[String]) {
    if args.len() >= 5 {
        println!(
            "{}",
            collect(
                &args[0],
                &args[1],
                &args[2],
                &args[3],
                &args[4],
                &SystemCommandRunner
            )
        );
    }
}

pub fn snippet(name: &str, log: &str) -> String {
    use crate::isolation::isolation_log::shell_quote;
    let exe = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "$".into());
    let stderr = if std::env::var("START_DEBUG").as_deref() == Ok("1") {
        "2>&1"
    } else {
        "2>/dev/null"
    };
    format!("{} __start-exit-evidence {} \"$__start_command_cgroup\" \"$__start_command_finished\" \"$__start_command_exit\" \"$__start_command_oom\" >> {} {}", shell_quote(&exe), shell_quote(name), log, stderr)
}
