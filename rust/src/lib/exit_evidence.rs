//! Exit-time evidence; cumulative cgroup counters and OOMKilled are historical.
use crate::execution_control::{CommandRunner, SystemCommandRunner};
use chrono::{DateTime, Duration};
pub const MAIN_OOM: &str = "Exit evidence: main-oom (recent cgroup oom_kill delta)";
pub const DOCKER_OOM: &str = "Exit evidence: main-oom (recent Docker oom event)";
pub const DAEMON_RESTART: &str = "Exit evidence: docker-daemon-restart (Docker service journal)";

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
    let last = log
        .unwrap_or("")
        .lines()
        .rfind(|s| s.starts_with("Exit evidence:"));
    (
        last == Some(MAIN_OOM) || last == Some(DOCKER_OOM),
        last == Some(DAEMON_RESTART),
    )
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
        Some(DAEMON_RESTART)
    } else if stored
        .and_then(|s| s.get("mainOom"))
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        Some(MAIN_OOM)
    } else if stored.is_some() {
        Some("Exit evidence: unavailable (no attributed exit-time OOM or daemon restart evidence)")
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
    if exit == "137" && !name.is_empty() {
        if let Ok(end) = DateTime::parse_from_rfc3339(finished) {
            let id = runner.run(
                &crate::docker_cleanup::docker_command().to_string_lossy(),
                &["inspect".into(), "-f".into(), "{{.Id}}".into(), name.into()],
            );
            let id_text = id.stdout.trim();
            if id.success && id_text.len() == 64 && id_text.chars().all(|c| c.is_ascii_hexdigit()) {
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
                if std::env::var("START_DEBUG").as_deref() == Ok("1") {
                    eprintln!("[DEBUG] Exit evidence: container={} finishedAt={} eventsAvailable={} oomEvents={:?} sample={:?}", id_text, finished, events.success, events.stdout, sample);
                }
            }
        }
    }
    if oom == "true"
        && (exit == "137" || exit.parse::<i32>().is_ok_and(|n| n < 0))
        && recent_oom_delta(sample, finished)
    {
        return MAIN_OOM.into();
    }
    "Exit evidence: unavailable (no attributed exit-time OOM or daemon restart evidence)".into()
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
