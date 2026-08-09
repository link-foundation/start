//! Metadata helpers for isolated executions.
//!
//! Builds the human-readable `[Isolation]` status lines and the execution
//! record options map that describe how an isolated command was launched,
//! including the configurable Docker runtime options (volumes, mounts,
//! environment variables, privileged mode). Kept separate from `isolation`
//! so the runtime backends and the metadata representation can evolve
//! independently.

use crate::args_parser::WrapperOptions;
use std::collections::HashMap;

/// Build the human-readable `[Isolation]` status lines for docker runtime
/// options (volumes, mounts, env, privileged). Used for the start block and
/// log header; empty collections contribute no lines.
pub fn docker_runtime_status_lines(
    volumes: &[String],
    mounts: &[String],
    env: &[String],
    privileged: bool,
    network: Option<&str>,
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
    if let Some(network) = network {
        lines.push(format!("[Isolation] Network: {}", network));
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
    docker_runtime_status_lines(
        &options.volumes,
        &options.mounts,
        &options.env,
        options.privileged,
        options.network.as_deref(),
        &options.network_aliases,
    )
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
    if let Some(network) = network {
        entries.push((
            "network".to_string(),
            serde_json::Value::String(network.to_string()),
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
        &options.network_aliases,
    ) {
        opts_map.insert(k, v);
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
