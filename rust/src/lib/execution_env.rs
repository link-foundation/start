//! START_* variables that tell a launched command which execution it belongs
//! to (issue #230). Every backend exports the same three variables, next to
//! the kill-recovery `START_COMMAND_RECOVERY_ATTEMPT`:
//!
//! - START_EXECUTION_ID: the execution UUID (`--session-id`)
//! - START_SESSION_NAME: the isolation session/container name (`--session`);
//!   empty for direct runs, which have no session
//! - START_ATTEMPT: 1 for the first run, n for the n-th attempt (`--resume`,
//!   kill recovery or `--append-attempt`), the same number `--status` shows
use crate::isolation::isolation_log::shell_quote;

pub const EXECUTION_ID_ENV: &str = "START_EXECUTION_ID";
pub const SESSION_NAME_ENV: &str = "START_SESSION_NAME";
pub const ATTEMPT_ENV: &str = "START_ATTEMPT";

/// Variables of one attempt, in a stable order; empty without an execution id.
pub type ExecutionEnv = Vec<(String, String)>;

/// Build the START_* variables for one attempt.
pub fn build_execution_env(
    execution_id: Option<&str>,
    session_name: Option<&str>,
    attempt: u64,
) -> ExecutionEnv {
    let Some(execution_id) = execution_id.filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    vec![
        (EXECUTION_ID_ENV.into(), execution_id.into()),
        (SESSION_NAME_ENV.into(), session_name.unwrap_or("").into()),
        (ATTEMPT_ENV.into(), attempt.max(1).to_string()),
    ]
}

/// Variables of an isolated launch: its execution UUID, the session or
/// container name and the attempt number.
pub fn execution_env_from_options(options: &crate::isolation::IsolationOptions) -> ExecutionEnv {
    build_execution_env(
        options.uuid.as_deref().or(options.execution_id.as_deref()),
        options.session.as_deref(),
        options.attempt_number,
    )
}

/// `KEY=value` assignments, e.g. for `docker run -e`.
pub fn execution_env_assignments(env: &ExecutionEnv) -> Vec<String> {
    env.iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect()
}

/// POSIX `export` statement for the variables, without a trailing separator.
pub fn build_execution_env_export(env: &ExecutionEnv) -> String {
    if env.is_empty() {
        return String::new();
    }
    let assignments: Vec<String> = env
        .iter()
        .map(|(key, value)| format!("{}={}", key, shell_quote(value)))
        .collect();
    format!("export {}", assignments.join(" "))
}

/// Prefix a shell command with the export statement. Used by the backends
/// whose command runs through a shell that does not inherit our environment:
/// a running tmux server, ssh, and `sudo` (which resets the environment).
pub fn prefix_with_execution_env(command: &str, env: &ExecutionEnv) -> String {
    let statement = build_execution_env_export(env);
    if statement.is_empty() {
        command.to_string()
    } else {
        format!("{}; {}", statement, command)
    }
}

/// True when this process was itself started by execution `execution_id`,
/// i.e. it is the next level of a stacked isolation that passes
/// `--session-id` down.
pub fn is_nested_launch_of(execution_id: &str, env_execution_id: Option<&str>) -> bool {
    !execution_id.is_empty() && env_execution_id == Some(execution_id)
}

/// `START_ATTEMPT` inherited by a nested level, when it is a positive number.
pub fn inherited_attempt(value: Option<&str>) -> u64 {
    value
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1)
}
