//! One `docker inspect` for every container a status query probes (issue #243).
//!
//! `--list` used to start one or two `docker inspect` processes per record
//! (the live state, the process IDs, the removal check), one after another,
//! and `--status` up to three for its one record. While a query runs, this
//! module asks Docker once for every field those probes read, and answers the
//! per-record `docker inspect -f <format> <target>` calls from that answer.
//!
//! Docker prints one line per found container, in argument order, and one
//! `No such container: <target>` line on stderr per missing one. Each line is
//! matched back to its target by name or ID prefix (Docker's own lookup
//! order), so the answer does not depend on the line order. A target the
//! batch cannot account for (an old or stubbed docker, a daemon error) is not
//! answered, and its per-record probe runs as before.

use crate::docker_cleanup::docker_command;
use crate::execution_control::CommandRunOutput;
use crate::execution_store::ExecutionRecord;
use regex::Regex;
use std::cell::RefCell;
use std::collections::HashMap;
use std::process::Command;
use std::sync::OnceLock;

/// Fields of the batched inspect, in output order.
pub const BATCH_FIELDS: [&str; 8] = [
    ".Name",
    ".Id",
    ".State.Pid",
    ".State.Running",
    ".State.ExitCode",
    ".State.OOMKilled",
    ".State.StartedAt",
    ".State.FinishedAt",
];

/// Fields of one found container, keyed by template field.
pub type BatchRow = HashMap<String, String>;

/// Answers per target: fields, or `None` for a target Docker reported missing.
pub type BatchAnswers = HashMap<String, Option<BatchRow>>;

thread_local! {
    /// Answers of the query in progress on this thread.
    static PREFETCHED: RefCell<Option<BatchAnswers>> = const { RefCell::new(None) };
}

/// The Go template of the batched inspect.
pub fn batch_format() -> String {
    BATCH_FIELDS
        .iter()
        .map(|field| format!("{{{{{}}}}}", field))
        .collect::<Vec<_>>()
        .join(" ")
}

fn not_found_line() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)no such (?:object|container):\s*(\S+)").unwrap())
}

fn placeholder() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\{\{\s*(\.[A-Za-z.]+)\s*\}\}").unwrap())
}

/// Containers the status probes of these records would inspect. Records whose
/// container is already marked removed are skipped: they are never probed.
pub fn docker_probe_targets(records: &[ExecutionRecord]) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for record in records {
        let isolated = record.options.get("isolated").and_then(|v| v.as_str());
        if isolated != Some("docker")
            || record.container_state.as_deref()
                == Some(crate::container_removal::CONTAINER_STATE_REMOVED)
        {
            continue;
        }
        for key in ["sessionName", "containerId"] {
            if let Some(target) = record.options.get(key).and_then(|v| v.as_str()) {
                if !target.is_empty() && !targets.iter().any(|t| t == target) {
                    targets.push(target.to_string());
                }
            }
        }
    }
    targets
}

/// Match a batched inspect answer to its targets; unanswered targets are
/// absent from the result.
pub fn parse_batch_inspect(targets: &[String], stdout: &str, stderr: &str) -> BatchAnswers {
    let rows: Vec<BatchRow> = stdout
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>())
        .filter(|parts| parts.len() == BATCH_FIELDS.len())
        .map(|parts| {
            BATCH_FIELDS
                .iter()
                .zip(parts)
                .map(|(field, value)| (field.to_string(), value.to_string()))
                .collect()
        })
        .collect();
    let missing: Vec<&str> = not_found_line()
        .captures_iter(stderr)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str()))
        .collect();
    let mut answers = BatchAnswers::new();
    for target in targets {
        // Docker's own "no such container" wins over a prefix of another
        // target's ID.
        if missing.contains(&target.as_str()) {
            answers.insert(target.clone(), None);
            continue;
        }
        let name = format!("/{}", target);
        let row = rows
            .iter()
            .find(|row| row[".Name"] == name)
            .or_else(|| rows.iter().find(|row| row[".Id"].starts_with(target)));
        if let Some(row) = row {
            answers.insert(target.clone(), Some(row.clone()));
        }
    }
    answers
}

fn run_batch_inspect(targets: &[String]) -> BatchAnswers {
    if targets.is_empty() {
        return BatchAnswers::new();
    }
    let output = Command::new(docker_command())
        .args(["inspect", "--type", "container", "-f", &batch_format()])
        .args(targets)
        .output();
    match output {
        Ok(output) => parse_batch_inspect(
            targets,
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Err(_) => BatchAnswers::new(),
    }
}

/// Clears the answers when the query ends, even by a panic.
struct PrefetchGuard;

impl Drop for PrefetchGuard {
    fn drop(&mut self) {
        PREFETCHED.with(|cell| cell.borrow_mut().take());
    }
}

/// Run `query` with the docker probes of `records` answered by one inspect.
/// Nested calls reuse the outer answer.
pub fn with_docker_inspect_batch<T>(records: &[ExecutionRecord], query: impl FnOnce() -> T) -> T {
    if PREFETCHED.with(|cell| cell.borrow().is_some()) {
        return query();
    }
    let answers = run_batch_inspect(&docker_probe_targets(records));
    PREFETCHED.with(|cell| *cell.borrow_mut() = Some(answers));
    let _guard = PrefetchGuard;
    query()
}

/// Answer `docker inspect -f <format> <target>` from the batch, or `None`
/// when the batch has no answer and the probe must run.
pub fn prefetched_inspect(format: &str, target: &str) -> Option<CommandRunOutput> {
    let row = PREFETCHED.with(|cell| cell.borrow().as_ref()?.get(target).cloned())?;
    let Some(row) = row else {
        return Some(CommandRunOutput {
            success: false,
            stdout: String::new(),
            stderr: format!(
                "Error response from daemon: No such container: {}\n",
                target
            ),
            status: Some(1),
            error: None,
        });
    };
    let mut known = true;
    let stdout =
        placeholder().replace_all(format, |caps: &regex::Captures| match row.get(&caps[1]) {
            Some(value) => value.clone(),
            None => {
                known = false;
                String::new()
            }
        });
    if !known || stdout.contains("{{") {
        return None;
    }
    Some(CommandRunOutput {
        success: true,
        stdout: format!("{}\n", stdout),
        stderr: String::new(),
        status: Some(0),
        error: None,
    })
}
