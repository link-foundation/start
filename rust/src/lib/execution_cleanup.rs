//! `$ --cleanup <uuid-or-session-name>` (issue #224): remove the Docker
//! containers of one execution and the snapshot images they were derived from.
//!
//! For callers that remove containers themselves: start-command's completion
//! watcher removes a snapshot image only when it removes the container. Nothing
//! here is forced, so Docker keeps any container that is still running and any
//! image that something else still uses; those are reported as retained.
//!
//! The containers are the current one and every earlier container of a
//! `--resume` chain (`sessionNameHistory`). The images are the
//! `start-command-resume/*` images named by the `start-command.snapshot-image`
//! label of those containers, by the record, and by the `-resume-N` names of
//! the chain, removed newest first.

use crate::docker_cleanup::docker_command;
use crate::docker_snapshot_safety::SNAPSHOT_IMAGE_LABEL;
use crate::execution_control::{CommandRunOutput, CommandRunner};
use crate::execution_resume::build_snapshot_image_name;
use crate::execution_store::{ExecutionRecord, ExecutionStore};
use crate::query_commands::QueryOutcome;
use serde_json::Value;

/// Whether `image` is a wrapper-owned `start-command-resume/<name>:<N>` image.
pub fn is_snapshot_image(image: &str) -> bool {
    let Some((name, attempt)) = image
        .strip_prefix("start-command-resume/")
        .and_then(|rest| rest.split_once(':'))
    else {
        return false;
    };
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
        && !attempt.is_empty()
        && attempt.chars().all(|c| c.is_ascii_digit())
}

/// Snapshot images implied by a `<name>-resume-<N>` chain, newest first.
pub fn chain_images(container_name: &str) -> Vec<String> {
    let mut images = Vec::new();
    let mut current = container_name;
    while let Some((base, attempt)) = current.rsplit_once("-resume-") {
        let Ok(number) = attempt.parse::<u64>() else {
            break;
        };
        if base.is_empty() || !attempt.chars().all(|c| c.is_ascii_digit()) {
            break;
        }
        images.push(build_snapshot_image_name(base, number));
        current = base;
    }
    images
}

fn attempt_of(image: &str) -> u64 {
    image
        .rsplit_once(':')
        .and_then(|(_, attempt)| attempt.parse().ok())
        .unwrap_or(0)
}

/// The containers and images `--cleanup <execution>` would remove.
pub fn plan_execution_cleanup<R: CommandRunner + ?Sized>(
    record: &ExecutionRecord,
    runner: &R,
) -> (Vec<String>, Vec<String>) {
    let option = |key: &str| {
        record
            .options
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let history = record
        .options
        .get("sessionNameHistory")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut containers: Vec<String> = Vec::new();
    for name in option("sessionName")
        .or_else(|| option("containerId"))
        .into_iter()
        .chain(history.into_iter().rev())
    {
        if !name.is_empty() && !containers.iter().any(|known| known == name) {
            containers.push(name.to_string());
        }
    }
    let docker = docker_command().to_string_lossy().to_string();
    let mut images: Vec<String> = option("snapshotImage")
        .map(String::from)
        .into_iter()
        .collect();
    for container in &containers {
        let labelled = runner.run(
            &docker,
            &[
                "inspect".into(),
                "-f".into(),
                format!("{{{{index .Config.Labels \"{}\"}}}}", SNAPSHOT_IMAGE_LABEL),
                container.clone(),
            ],
        );
        if labelled.success {
            images.push(labelled.stdout.trim().to_string());
        }
        images.extend(chain_images(container));
    }
    let mut unique: Vec<String> = Vec::new();
    for image in images {
        if is_snapshot_image(&image) && !unique.contains(&image) {
            unique.push(image);
        }
    }
    // Stable, like Array.prototype.sort: equal attempts keep their order.
    unique.sort_by_key(|image| std::cmp::Reverse(attempt_of(image)));
    (containers, unique)
}

/// What happened to one Docker object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupState {
    Removed,
    Absent,
    Retained,
    /// Dry run: the object exists and would be removed.
    Present,
}

pub struct CleanupOutcome {
    pub kind: &'static str,
    pub name: String,
    pub state: CleanupState,
    pub detail: Option<String>,
}

fn error_text(result: &CommandRunOutput) -> String {
    let stderr = result.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    result.error.clone().unwrap_or_else(|| {
        format!(
            "exit code {}",
            result
                .status
                .map(|code| code.to_string())
                .unwrap_or_else(|| "null".into())
        )
    })
}

fn is_not_found(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    ["no such container", "no such image", "no such object"]
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// Remove (or, with `dry_run`, look up) one object without force.
fn remove_object<R: CommandRunner + ?Sized>(
    kind: &'static str,
    name: &str,
    runner: &R,
    dry_run: bool,
) -> CleanupOutcome {
    let args: Vec<String> = match (dry_run, kind) {
        (true, _) => vec![
            if kind == "image" {
                "image"
            } else {
                "container"
            }
            .into(),
            "inspect".into(),
            "--format".into(),
            "{{.Id}}".into(),
            name.into(),
        ],
        (false, "image") => vec!["rmi".into(), name.into()],
        (false, _) => vec!["rm".into(), name.into()],
    };
    let result = runner.run(&docker_command().to_string_lossy(), &args);
    let outcome = |state, detail| CleanupOutcome {
        kind,
        name: name.to_string(),
        state,
        detail,
    };
    if result.success {
        return outcome(
            if dry_run {
                CleanupState::Present
            } else {
                CleanupState::Removed
            },
            None,
        );
    }
    let detail = error_text(&result);
    if result.error.is_none() && is_not_found(&detail) {
        return outcome(CleanupState::Absent, None);
    }
    outcome(CleanupState::Retained, Some(detail))
}

fn format_outcome(outcome: &CleanupOutcome) -> String {
    let label = match outcome.state {
        CleanupState::Removed => "Removed",
        CleanupState::Absent => "Already gone:",
        CleanupState::Retained => "Retained",
        CleanupState::Present => "Would remove",
    };
    let line = format!("{} {} {}", label, outcome.kind, outcome.name);
    match &outcome.detail {
        Some(detail) => format!("{} ({})", line, detail),
        None => line,
    }
}

fn failure(error: String) -> QueryOutcome {
    QueryOutcome {
        success: false,
        output: None,
        error: Some(error),
        exit_code: None,
    }
}

/// Remove one execution's containers, then its snapshot images.
pub fn cleanup_execution<R: CommandRunner + ?Sized>(
    store: Option<&ExecutionStore>,
    identifier: &str,
    dry_run: bool,
    runner: &R,
) -> QueryOutcome {
    let Some(store) = store else {
        return failure("Execution tracking is disabled.".into());
    };
    let Some(record) = store.get(identifier) else {
        return failure(format!(
            "No execution found with UUID or session name: {}",
            identifier
        ));
    };
    if record.options.get("isolated").and_then(Value::as_str) != Some("docker") {
        return failure(format!(
            "--cleanup <execution> only removes Docker containers and images; {} is not a Docker execution.",
            identifier
        ));
    }
    let (containers, images) = plan_execution_cleanup(&record, runner);
    let mut outcomes: Vec<CleanupOutcome> = containers
        .iter()
        .map(|name| remove_object("container", name, runner, dry_run))
        .collect();
    // Images go only after their containers; Docker refuses a used image.
    for image in &images {
        outcomes.push(remove_object("image", image, runner, dry_run));
    }
    if !dry_run
        && outcomes.first().is_some_and(|current| {
            matches!(current.state, CleanupState::Removed | CleanupState::Absent)
        })
    {
        let _ = store.mark_container_removed(&record.uuid, &chrono::Utc::now().to_rfc3339());
    }
    let retained = outcomes
        .iter()
        .filter(|outcome| outcome.state == CleanupState::Retained)
        .count();
    let output = if outcomes.is_empty() {
        "No containers or snapshot images recorded for this execution.".to_string()
    } else {
        outcomes
            .iter()
            .map(format_outcome)
            .collect::<Vec<_>>()
            .join("\n")
    };
    QueryOutcome {
        success: retained == 0,
        output: Some(output),
        error: (retained > 0).then(|| {
            format!(
                "{} Docker object(s) retained; nothing was forced.",
                retained
            )
        }),
        exit_code: None,
    }
}
