//! Removed-container bookkeeping for `--status` (issue #225).
//!
//! A kept docker container can be removed later (by hand, by an orchestrator,
//! or by start-command's own cleanup policy). `docker inspect` then exits 1
//! with `No such object` / `No such container`, which used to be folded into
//! the same `None` as "docker could not be queried at all", so `--status` kept
//! reporting the old `containerId` as if the container still held its disk.
//!
//! This module tells the two failures apart and records the removal on the
//! execution record as `containerState: removed` plus
//! `containerRemovedObservedAt`. `containerId` is kept for history.

use std::process::Command;

use chrono::Utc;

use crate::docker_cleanup::docker_command;
use crate::execution_store::{ExecutionRecord, ExecutionStatus, ExecutionStore};

/// `containerState` of a record whose container no longer exists.
pub const CONTAINER_STATE_REMOVED: &str = "removed";

/// Environment variable the detached watcher sets for the finalizer when its
/// own `docker rm -f` removed the container.
pub const CONTAINER_REMOVED_ENV: &str = "START_INTERNAL_CONTAINER_REMOVED";

/// Whether a failed `docker inspect` answered that the object is unknown:
/// `Error: No such object: <name>` (`docker inspect`, Docker 29 prints it
/// lower-case) or `Error response from daemon: No such container: <name>`. A
/// daemon that cannot be reached ("Cannot connect", "failed to connect ... no
/// such file or directory") does not match.
pub fn is_docker_not_found(success: bool, stderr: &str) -> bool {
    if success {
        return false;
    }
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("no such object") || stderr.contains("no such container")
}

/// `docker inspect -f {{.Id}} <target>` answered "no such container".
fn docker_object_missing(target: &str) -> bool {
    Command::new(docker_command())
        .args(["inspect", "-f", "{{.Id}}", target])
        .output()
        .is_ok_and(|output| {
            is_docker_not_found(
                output.status.success(),
                &String::from_utf8_lossy(&output.stderr),
            )
        })
}

/// Set `containerState: removed` on a record, keeping an earlier observation
/// time when there is one.
pub fn mark_container_removed(record: &mut ExecutionRecord, observed_at: Option<&str>) {
    record.container_state = Some(CONTAINER_STATE_REMOVED.to_string());
    if record.container_removed_observed_at.is_none() {
        record.container_removed_observed_at = Some(
            observed_at
                .map(str::to_string)
                .unwrap_or_else(|| Utc::now().to_rfc3339()),
        );
    }
}

fn option_str<'a>(record: &'a ExecutionRecord, key: &str) -> Option<&'a str> {
    record
        .options
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
}

/// Whether a finished detached docker record should be checked for removal.
/// Executing records are never touched: a container that is not visible yet
/// on a slow Docker-in-Docker host is not a removed one (issue #136).
fn should_probe_removal(record: &ExecutionRecord) -> bool {
    record.status == ExecutionStatus::Executed
        && option_str(record, "isolated") == Some("docker")
        && option_str(record, "isolationMode") == Some("detached")
        && (option_str(record, "sessionName").is_some()
            || option_str(record, "containerId").is_some())
        && record.container_state.as_deref() != Some(CONTAINER_STATE_REMOVED)
}

/// Attach `containerState: removed` to a finished detached docker record whose
/// container no longer exists. The container id is preferred over the session
/// name, so a later container that reuses the name is not mistaken for it.
pub fn attach_container_removal(mut record: ExecutionRecord) -> ExecutionRecord {
    if !should_probe_removal(&record) {
        return record;
    }
    let target = option_str(&record, "containerId")
        .or_else(|| option_str(&record, "sessionName"))
        .map(str::to_string);
    if target.is_some_and(|target| docker_object_missing(&target)) {
        mark_container_removed(&mut record, None);
    }
    record
}

/// Persist a removal `--status` observed, best effort: a read-only query must
/// never fail because the store could not be written.
pub fn persist_container_removal(
    store: &ExecutionStore,
    stored: &ExecutionRecord,
    enriched: &ExecutionRecord,
) {
    if enriched.container_state.as_deref() != Some(CONTAINER_STATE_REMOVED)
        || stored.container_state.as_deref() == Some(CONTAINER_STATE_REMOVED)
    {
        return;
    }
    if let Some(observed_at) = enriched.container_removed_observed_at.as_deref() {
        // The removal is still reported; it is simply observed again next time.
        let _ = store.mark_container_removed(&stored.uuid, observed_at);
    }
}
