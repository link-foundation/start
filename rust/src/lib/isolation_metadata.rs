//! Metadata helpers for isolated executions.
//!
//! Builds the human-readable `[Isolation]` status lines and the execution
//! record options map that describe how an isolated command was launched,
//! including the configurable Docker runtime options (volumes, mounts,
//! environment variables, privileged mode). Kept separate from `isolation`
//! so the runtime backends and the metadata representation can evolve
//! independently.

use crate::args_parser::WrapperOptions;
use crate::recovery_delay::effective_on_kill_resume_delay;
use std::collections::HashMap;

/// Container labels are immutable, so resume counters describe container creation.
/// Snapshot containers get new attribution; in-place restarts retain their labels.
pub fn docker_attribution_labels(
    options: &crate::isolation::IsolationOptions,
    session: &str,
) -> Vec<String> {
    let mut labels = options.labels.clone();
    let mut inferred_root = session;
    if options.resume_count > 0 {
        while let Some((prefix, count)) = inferred_root.rsplit_once("-resume-") {
            if count.is_empty() || !count.bytes().all(|byte| byte.is_ascii_digit()) {
                break;
            }
            inferred_root = prefix;
        }
    }
    let root = options.root_session.as_deref().unwrap_or(inferred_root);
    let uuid = options
        .uuid
        .clone()
        .or_else(|| options.execution_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    labels.extend([
        format!("start-command.session={}", session),
        format!("start-command.root-session={}", root),
        format!("start-command.uuid={}", uuid),
        format!("start-command.resume-count={}", options.resume_count),
    ]);
    labels
}

/// Build the human-readable `[Isolation]` status lines for docker runtime
/// options (volumes, mounts, env, privileged). Used for the start block and
/// log header; empty collections contribute no lines.
pub fn docker_runtime_status_lines(
    volumes: &[String],
    mounts: &[String],
    env: &[String],
    privileged: bool,
    network: Option<&str>,
    networks: &[String],
    network_aliases: &[String],
) -> Vec<String> {
    let mut lines = Vec::new();
    if !volumes.is_empty() {
        lines.push(format!("[Isolation] Volumes: {}", volumes.join(", ")));
    }
    if !mounts.is_empty() {
        lines.push(format!("[Isolation] Mounts: {}", mounts.join(", ")));
    }
    if !env.is_empty() {
        lines.push(format!("[Isolation] Env: {}", env.join(", ")));
    }
    if privileged {
        lines.push("[Isolation] Privileged: true".to_string());
    }
    let resolved_networks = if networks.is_empty() {
        network.into_iter().collect::<Vec<_>>()
    } else {
        networks.iter().map(String::as_str).collect::<Vec<_>>()
    };
    if let Some(first_network) = resolved_networks.first() {
        lines.push(format!("[Isolation] Network: {}", first_network));
    }
    if resolved_networks.len() > 1 {
        lines.push(format!(
            "[Isolation] Networks: {}",
            resolved_networks.join(", ")
        ));
    }
    if !network_aliases.is_empty() {
        lines.push(format!(
            "[Isolation] Network aliases: {}",
            network_aliases.join(", ")
        ));
    }
    lines
}

/// Build Docker runtime status lines directly from parsed wrapper options.
pub fn docker_runtime_status_lines_for_options(options: &WrapperOptions) -> Vec<String> {
    let mut lines = docker_runtime_status_lines(
        &options.volumes,
        &options.mounts,
        &options.env,
        options.privileged,
        options.network.as_deref(),
        &options.networks,
        &options.network_aliases,
    );
    if !options.labels.is_empty() {
        lines.push(format!("[Isolation] Labels: {}", options.labels.join(", ")));
    }
    if let Some(line) = crate::docker_resource_options::log_line(
        &crate::docker_resource_options::specs(options),
        &options.resolved_limits,
    ) {
        lines.push(line);
    }
    lines.extend(recovery_status_lines_with_delay(
        options.on_kill_resume,
        options.recovery_command.as_deref(),
        options.on_kill_resume_delay.as_deref(),
    ));
    lines
}

/// `[Isolation]` line announcing launch-time kill recovery (issue #176).
/// A recovery command on its own implies one attempt.
pub fn recovery_status_lines(
    on_kill_resume: Option<u32>,
    recovery_command: Option<&str>,
) -> Vec<String> {
    recovery_status_lines_with_delay(on_kill_resume, recovery_command, None)
}

/// [`recovery_status_lines`] that also names the random delay before each
/// resume (issue #181).
pub fn recovery_status_lines_with_delay(
    on_kill_resume: Option<u32>,
    recovery_command: Option<&str>,
    on_kill_resume_delay: Option<&str>,
) -> Vec<String> {
    let Some(count) = effective_on_kill_resume(on_kill_resume, recovery_command) else {
        return Vec::new();
    };
    let after = effective_on_kill_resume_delay(on_kill_resume_delay)
        .map(|delay| format!(" after a random {}s delay", delay))
        .unwrap_or_default();
    vec![format!(
        "[Isolation] On kill: resume up to {} time(s){} with {}",
        count,
        after,
        recovery_command.unwrap_or("the original command")
    )]
}

fn effective_on_kill_resume(
    on_kill_resume: Option<u32>,
    recovery_command: Option<&str>,
) -> Option<u32> {
    on_kill_resume
        .filter(|count| *count > 0)
        .or_else(|| recovery_command.map(|_| 1))
}

/// Execution-record metadata for launch-time kill recovery (issue #176).
pub fn recovery_metadata(
    on_kill_resume: Option<u32>,
    recovery_command: Option<&str>,
) -> Vec<(String, serde_json::Value)> {
    recovery_metadata_with_delay(on_kill_resume, recovery_command, None)
}

/// [`recovery_metadata`] plus the normalized `onKillResumeDelay` range
/// (issue #181), stored only when it is not zero.
pub fn recovery_metadata_with_delay(
    on_kill_resume: Option<u32>,
    recovery_command: Option<&str>,
    on_kill_resume_delay: Option<&str>,
) -> Vec<(String, serde_json::Value)> {
    let mut entries = Vec::new();
    let Some(count) = effective_on_kill_resume(on_kill_resume, recovery_command) else {
        return entries;
    };
    entries.push(("onKillResume".to_string(), serde_json::json!(count)));
    if let Some(command) = recovery_command {
        entries.push(("recoveryCommand".to_string(), serde_json::json!(command)));
    }
    if let Some(delay) = effective_on_kill_resume_delay(on_kill_resume_delay) {
        entries.push(("onKillResumeDelay".to_string(), serde_json::json!(delay)));
    }
    entries
}

/// Build the execution-record metadata entries for docker runtime options.
/// Returns `(key, value)` pairs to merge into the options map; empty
/// collections and a false `privileged` flag contribute no entries.
pub fn docker_runtime_metadata(
    volumes: &[String],
    mounts: &[String],
    env: &[String],
    privileged: bool,
    network: Option<&str>,
    networks: &[String],
    network_aliases: &[String],
) -> Vec<(String, serde_json::Value)> {
    let arr = |items: &[String]| {
        serde_json::Value::Array(
            items
                .iter()
                .map(|s| serde_json::Value::String(s.clone()))
                .collect(),
        )
    };
    let mut entries = Vec::new();
    if !volumes.is_empty() {
        entries.push(("volumes".to_string(), arr(volumes)));
    }
    if !mounts.is_empty() {
        entries.push(("mounts".to_string(), arr(mounts)));
    }
    if !env.is_empty() {
        entries.push(("env".to_string(), arr(env)));
    }
    if privileged {
        entries.push(("privileged".to_string(), serde_json::Value::Bool(true)));
    }
    let resolved_networks = if networks.is_empty() {
        network.into_iter().collect::<Vec<_>>()
    } else {
        networks.iter().map(String::as_str).collect::<Vec<_>>()
    };
    if let Some(network) = resolved_networks.first() {
        entries.push((
            "network".to_string(),
            serde_json::Value::String((*network).to_string()),
        ));
        entries.push((
            "networks".to_string(),
            serde_json::Value::Array(
                resolved_networks
                    .iter()
                    .map(|value| serde_json::Value::String((*value).to_string()))
                    .collect(),
            ),
        ));
    }
    if !network_aliases.is_empty() {
        entries.push(("networkAliases".to_string(), arr(network_aliases)));
    }
    entries
}

/// Build the execution-record options map describing how an isolated command
/// was launched (environment, mode, session, image, docker runtime options,
/// endpoint, user, keep-alive). Used to persist the execution record so it can
/// be surfaced via `--status`/`--list`.
pub fn build_isolation_options_map(
    environment: Option<&str>,
    mode: &str,
    session_name: &str,
    effective_image: Option<&str>,
    options: &WrapperOptions,
    created_user: Option<&str>,
) -> HashMap<String, serde_json::Value> {
    let str_val = |s: &str| serde_json::Value::String(s.to_string());
    let mut opts_map = HashMap::new();
    if !options.labels.is_empty() {
        opts_map.insert("labels".to_string(), serde_json::json!(options.labels));
    }
    if environment == Some("docker") && mode == "detached" {
        opts_map.insert("commandHandoff".to_string(), serde_json::json!(true));
    }
    if let Some(env) = environment {
        opts_map.insert("isolated".to_string(), str_val(env));
    }
    opts_map.insert("isolationMode".to_string(), str_val(mode));
    opts_map.insert("sessionName".to_string(), str_val(session_name));
    if let Some(v) = effective_image {
        opts_map.insert("image".to_string(), str_val(v));
    }
    for (k, v) in docker_runtime_metadata(
        &options.volumes,
        &options.mounts,
        &options.env,
        options.privileged,
        options.network.as_deref(),
        &options.networks,
        &options.network_aliases,
    )
    .into_iter()
    .chain(recovery_metadata_with_delay(
        options.on_kill_resume,
        options.recovery_command.as_deref(),
        options.on_kill_resume_delay.as_deref(),
    )) {
        opts_map.insert(k, v);
    }
    if let Some(config) = &options.cpu_penalty_config {
        opts_map.insert("cpuPenaltyConfig".into(), serde_json::json!(config));
        opts_map.insert(
            "baseResourceLimits".into(),
            serde_json::json!(options.resource_limits),
        );
    }
    opts_map.insert(
        "resourceLimits".into(),
        serde_json::json!(options.resource_limits),
    );
    opts_map.insert("resolvedLimits".into(), options.resolved_limits.clone());
    opts_map.insert(
        "resourceLimitSpecs".into(),
        crate::docker_resource_options::specs(options),
    );
    if let Some(value) = &options.on_kill_resume_memory {
        opts_map.insert("onKillResumeMemory".into(), serde_json::json!(value));
    }
    if let Some(v) = &options.endpoint {
        opts_map.insert("endpoint".to_string(), str_val(v));
    }
    if let Some(v) = created_user {
        opts_map.insert("user".to_string(), str_val(v));
    }
    opts_map.insert(
        "keepAlive".to_string(),
        serde_json::Value::Bool(options.keep_alive),
    );
    opts_map.insert(
        "autoRemoveDockerContainer".to_string(),
        serde_json::Value::Bool(options.auto_remove_docker_container),
    );
    opts_map.insert(
        "alwaysCleanupContainer".to_string(),
        serde_json::Value::Bool(options.always_cleanup_container),
    );
    opts_map.insert(
        "keepContainer".to_string(),
        serde_json::Value::Bool(options.keep_container),
    );
    opts_map.insert(
        "keepContainerOnFail".to_string(),
        serde_json::Value::Bool(options.keep_container_on_fail),
    );
    opts_map
}

#[cfg(test)]
#[path = "isolation_metadata_cases.rs"]
mod tests;
