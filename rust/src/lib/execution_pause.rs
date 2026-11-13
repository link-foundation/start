//! `$ --pause <id>` and `$ --unpause <id>` (issue #263): freeze and thaw a
//! detached Docker execution with the cgroup freezer.
//!
//! `docker pause` stops every process of the container from being scheduled,
//! so CPU is released, while the processes, their memory, the container, its
//! workspace and its log all stay exactly where they are. `docker unpause`
//! continues the very same processes: there is no new container, command,
//! snapshot, execution or recovery attempt. To get the memory back, `--stop`
//! the execution instead.
//!
//! Only Docker can freeze a session; screen and tmux are refused. The pause is
//! recorded on the execution as `options.paused`, `pausedAt`, `pauseCount` and
//! the optional `pausedBy` / `pauseReason`, but Docker stays the source of
//! truth: `--status`, `--list` and the controls reconcile a stale record from
//! `docker inspect` (after a daemon restart, a reboot or a removal), so a stale
//! `paused: true` can never hide a task.

use crate::docker_cleanup::docker_command;
use crate::execution_control::{
    collect_process_ids_with_runner, CommandRunOutput, CommandRunner, SystemCommandRunner,
};
use crate::execution_store::{ExecutionRecord, ExecutionStore};
use crate::output_blocks::{escape_for_links_notation, format_value_for_links_notation};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Duration;

/// Bound for every docker call made here, so a hung daemon cannot hang us.
pub const DOCKER_PAUSE_TIMEOUT: Duration = Duration::from_secs(30);

/// `docker inspect` template answering both the status and the freezer flag.
pub const PAUSE_STATE_FORMAT: &str = "{{.State.Status}} {{.State.Paused}}";

/// Docker states an execution can be reported in (plus `removed`/`unknown`).
pub mod docker_state {
    pub const RUNNING: &str = "running";
    pub const PAUSED: &str = "paused";
    pub const EXITED: &str = "exited";
    pub const CREATED: &str = "created";
    pub const REMOVED: &str = "removed";
    pub const UNKNOWN: &str = "unknown";
}

/// Pause bookkeeping kept in `options`; cleared when the pause ends.
pub const PAUSE_FIELDS: [&str; 3] = ["pausedAt", "pausedBy", "pauseReason"];

/// What a pause does to the container's resources, for callers' accounting.
pub fn paused_resources() -> Value {
    json!({ "cpu": "released", "memory": "retained", "disk": "retained" })
}

type Options = HashMap<String, Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseAction {
    Pause,
    Unpause,
}

impl PauseAction {
    pub fn as_str(self) -> &'static str {
        match self {
            PauseAction::Pause => "pause",
            PauseAction::Unpause => "unpause",
        }
    }
}

/// What Docker says about a container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PauseState {
    pub state: String,
    pub paused: bool,
    pub detail: Option<String>,
}

/// Who and why, plus the output format, of one `--pause`/`--unpause`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PauseRequest<'a> {
    pub reason: Option<&'a str>,
    pub by: Option<&'a str>,
    pub output_format: Option<&'a str>,
}

pub struct ExecutionPauseResult {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}

impl ExecutionPauseResult {
    fn fail(error: String) -> Self {
        ExecutionPauseResult {
            success: false,
            output: None,
            error: Some(error),
        }
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn option_str<'a>(options: &'a Options, key: &str) -> Option<&'a str> {
    options
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn is_paused_option(options: &Options) -> bool {
    options.get("paused").and_then(Value::as_bool) == Some(true)
}

fn failure_detail(result: &CommandRunOutput) -> String {
    let stderr = result.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    result
        .error
        .clone()
        .unwrap_or_else(|| format!("exit code {}", result.status.unwrap_or(-1)))
}

fn is_not_found(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    detail.contains("no such object") || detail.contains("no such container")
}

/// Parse `docker inspect -f '{{.State.Status}} {{.State.Paused}}'` output.
pub fn parse_pause_state(stdout: &str) -> PauseState {
    let mut parts = stdout.split_whitespace();
    let state = parts
        .next()
        .map(str::to_lowercase)
        .unwrap_or_else(|| docker_state::UNKNOWN.to_string());
    let paused = parts.next() == Some("true") || state == docker_state::PAUSED;
    PauseState {
        state: if paused {
            docker_state::PAUSED.to_string()
        } else {
            state
        },
        paused,
        detail: None,
    }
}

/// Ask Docker for the real state of a container: `removed` when Docker answers
/// "no such container", `unknown` when it cannot be asked. Answered by the
/// query's batched inspect when there is one (issue #243).
pub fn inspect_pause_state<R: CommandRunner + ?Sized>(container_name: &str, runner: &R) -> PauseState {
    let result =
        crate::docker_inspect_batch::prefetched_inspect(PAUSE_STATE_FORMAT, container_name)
            .unwrap_or_else(|| {
                runner.run_with_timeout(
                    &docker_command().to_string_lossy(),
                    &[
                        "inspect".to_string(),
                        "-f".to_string(),
                        PAUSE_STATE_FORMAT.to_string(),
                        container_name.to_string(),
                    ],
                    DOCKER_PAUSE_TIMEOUT,
                )
            });
    if result.success {
        return parse_pause_state(&result.stdout);
    }
    let detail = failure_detail(&result);
    if result.error.is_none() && is_not_found(&detail) {
        return PauseState {
            state: docker_state::REMOVED.to_string(),
            paused: false,
            detail: None,
        };
    }
    PauseState {
        state: docker_state::UNKNOWN.to_string(),
        paused: false,
        detail: Some(detail),
    }
}

fn is_detached_docker(record: &ExecutionRecord) -> bool {
    option_str(&record.options, "isolated") == Some("docker")
        && option_str(&record.options, "isolationMode") == Some("detached")
}

fn is_marked_removed(record: &ExecutionRecord) -> bool {
    record.container_state.as_deref() == Some(docker_state::REMOVED)
}

/// Whether a record is a detached Docker execution that Docker confirms is
/// paused right now. A stale `options.paused` alone never counts.
pub fn is_confirmed_paused<R: CommandRunner + ?Sized>(record: &ExecutionRecord, runner: &R) -> bool {
    let Some(name) = option_str(&record.options, "sessionName") else {
        return false;
    };
    if !is_detached_docker(record) || is_marked_removed(record) {
        return false;
    }
    inspect_pause_state(name, runner).paused
}

/// Options of a record whose pause just ended (`ended_by`: unpause, stop,
/// terminate or reconcile).
pub fn cleared_pause_options(options: &Options, ended_by: &str, at: Option<&str>) -> Options {
    let mut next = options.clone();
    for field in PAUSE_FIELDS {
        next.remove(field);
    }
    next.insert("paused".to_string(), json!(false));
    next.insert(
        "unpausedAt".to_string(),
        json!(at.map(str::to_string).unwrap_or_else(now)),
    );
    next.insert("pauseEndedBy".to_string(), json!(ended_by));
    next
}

/// Options of a record that was just paused.
pub fn paused_options(
    options: &Options,
    reason: Option<&str>,
    by: Option<&str>,
    at: Option<&str>,
) -> Options {
    let mut next = options.clone();
    for field in ["unpausedAt", "pauseEndedBy", "pausedBy", "pauseReason"] {
        next.remove(field);
    }
    let count = next
        .get("pauseCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    next.insert("paused".to_string(), json!(true));
    next.insert(
        "pausedAt".to_string(),
        json!(at.map(str::to_string).unwrap_or_else(now)),
    );
    next.insert("pauseCount".to_string(), json!(count + 1));
    if let Some(by) = by.filter(|by| !by.is_empty()) {
        next.insert("pausedBy".to_string(), json!(by));
    }
    if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
        next.insert("pauseReason".to_string(), json!(reason));
    }
    next
}

/// Re-read the record and save new options on it, best effort for
/// reconciliation and strict for the pause/unpause transitions themselves.
fn save_options(
    store: &ExecutionStore,
    record: &ExecutionRecord,
    update: impl FnOnce(&Options) -> Options,
    strict: bool,
) -> Result<ExecutionRecord, String> {
    let mut current = store.get(&record.uuid).unwrap_or_else(|| record.clone());
    current.options = update(&current.options);
    match store.save(&current) {
        Err(error) if strict => Err(error),
        _ => Ok(current),
    }
}

/// Forget a pause that Docker no longer confirms (issue #263): a container that
/// was stopped, removed, restarted by the daemon or thawed by hand.
pub fn reconcile_stale_pause(
    store: &ExecutionStore,
    record: &ExecutionRecord,
    ended_by: &str,
) -> ExecutionRecord {
    if !is_paused_option(&record.options) {
        return record.clone();
    }
    save_options(
        store,
        record,
        |options| cleared_pause_options(options, ended_by, None),
        false,
    )
    .unwrap_or_else(|_| record.clone())
}

/// End the recorded pause of an execution that `--stop` / `--terminate` just
/// ended (issue #263). No-op when it was not paused.
pub fn clear_pause_after_control(store: &ExecutionStore, record: &ExecutionRecord, action: &str) {
    if is_paused_option(&record.options) {
        reconcile_stale_pause(store, record, action);
    }
}

/// Validate that an execution can be paused/unpaused at all.
fn resolve_pause_target<'s>(
    store: Option<&'s ExecutionStore>,
    identifier: &str,
    action: PauseAction,
) -> Result<(&'s ExecutionStore, ExecutionRecord), String> {
    let store = store.ok_or_else(|| "Execution tracking is disabled.".to_string())?;
    let record = store
        .get(identifier)
        .ok_or_else(|| format!("No execution found with UUID or session name: {}", identifier))?;
    let isolated = option_str(&record.options, "isolated");
    if isolated != Some("docker") {
        return Err(format!(
            "--{} only supports Docker isolation: {} uses {}. \
             screen and tmux sessions cannot be frozen; use --stop or --terminate instead.",
            action.as_str(),
            identifier,
            isolated.unwrap_or("no isolation")
        ));
    }
    if option_str(&record.options, "sessionName").is_none() {
        return Err("Execution record does not contain an isolation session name.".to_string());
    }
    if option_str(&record.options, "isolationMode") != Some("detached") {
        return Err(format!(
            "Only detached Docker executions can be {}d.",
            action.as_str()
        ));
    }
    Ok((store, record))
}

fn not_pausable_error(
    action: PauseAction,
    identifier: &str,
    record: &ExecutionRecord,
    state: &PauseState,
) -> String {
    let name = option_str(&record.options, "sessionName").unwrap_or("");
    let what = if state.state == docker_state::REMOVED {
        "no longer exists (removed)".to_string()
    } else {
        let expected = match action {
            PauseAction::Pause => "running",
            PauseAction::Unpause => "paused",
        };
        format!("is {}, not {}", state.state, expected)
    };
    format!(
        "Cannot {} {}: container \"{}\" {}. Use `$ --status {}` to inspect it, or `$ --resume {}` to continue it.",
        action.as_str(),
        identifier,
        name,
        what,
        record.uuid,
        record.uuid
    )
}

/// One pause/unpause outcome, before it is rendered.
pub struct PauseOutcome<'a> {
    pub action: PauseAction,
    pub identifier: &'a str,
    pub record: &'a ExecutionRecord,
    pub status: &'a str,
    pub method: &'a str,
    pub docker_state: &'a str,
    pub process_ids: Option<Value>,
    pub message: String,
}

/// Report of one pause/unpause, as ordered `(key, value)` pairs.
pub fn build_pause_report(outcome: &PauseOutcome) -> Vec<(String, Value)> {
    let opts = &outcome.record.options;
    let paused = outcome.docker_state == docker_state::PAUSED;
    let mut report: Vec<(String, Value)> = vec![
        ("action".into(), json!(outcome.action.as_str())),
        ("identifier".into(), json!(outcome.identifier)),
        ("uuid".into(), json!(outcome.record.uuid)),
        ("status".into(), json!(outcome.status)),
        ("backend".into(), json!(option_str(opts, "isolated"))),
        ("sessionName".into(), json!(option_str(opts, "sessionName"))),
        ("method".into(), json!(outcome.method)),
        ("dockerState".into(), json!(outcome.docker_state)),
        ("paused".into(), json!(paused)),
    ];
    if paused {
        report.push(("pausedAt".into(), json!(option_str(opts, "pausedAt"))));
        report.push((
            "pauseCount".into(),
            json!(opts.get("pauseCount").and_then(Value::as_u64).unwrap_or(0)),
        ));
        for key in ["pausedBy", "pauseReason"] {
            if let Some(value) = option_str(opts, key) {
                report.push((key.into(), json!(value)));
            }
        }
        report.push(("resources".into(), paused_resources()));
    } else if let Some(at) = option_str(opts, "unpausedAt") {
        report.push(("unpausedAt".into(), json!(at)));
    }
    if let Some(process_ids) = &outcome.process_ids {
        report.push(("processIds".into(), process_ids.clone()));
    }
    report.push(("message".into(), json!(outcome.message)));
    report
}

fn links_scalar(value: &Value) -> String {
    match value {
        Value::String(text) => escape_for_links_notation(text),
        other => format_value_for_links_notation(other),
    }
}

fn format_report_as_links_notation(report: &[(String, Value)]) -> String {
    let mut lines = vec!["executionControl".to_string()];
    for (key, value) in report {
        match value {
            Value::Object(map) => {
                lines.push(format!("  {}", key));
                for (child, child_value) in map {
                    lines.push(format!("      {} {}", child, links_scalar(child_value)));
                }
            }
            other => lines.push(format!("  {} {}", key, links_scalar(other))),
        }
    }
    lines.join("\n")
}

fn format_report_as_text(report: &[(String, Value)]) -> String {
    let get = |key: &str| report.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    let text = |key: &str| match get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "N/A".to_string(),
        Some(other) => other.to_string(),
    };
    let paused = get("paused").and_then(Value::as_bool) == Some(true);
    let mut lines = vec![
        text("message"),
        format!("UUID:          {}", text("uuid")),
        format!("Container:     {}", text("sessionName")),
        format!("Docker State:  {}", text("dockerState")),
        format!("Paused:        {}", paused),
    ];
    if paused {
        lines.push(format!("Paused At:     {}", text("pausedAt")));
        lines.push(format!("Pause Count:   {}", text("pauseCount")));
        lines.push(
            "Resources:     CPU released, memory retained, disk retained".to_string(),
        );
    }
    if let Some(pid) = get("processIds").and_then(|ids| ids.get("containerPid")) {
        lines.push(format!("Container PID: {}", pid));
    }
    lines.join("\n")
}

/// Render a pause/unpause report: links-notation (default), json or text.
pub fn format_pause_report(report: &[(String, Value)], output_format: Option<&str>) -> String {
    match output_format {
        Some("json") => {
            let map: Map<String, Value> = report.iter().cloned().collect();
            serde_json::to_string_pretty(&Value::Object(map)).unwrap_or_default()
        }
        Some("text") => format_report_as_text(report),
        _ => format_report_as_links_notation(report),
    }
}

/// Every docker call of `--pause`/`--unpause` is bounded, the PID lookup too.
struct BoundedRunner<'a, R: CommandRunner>(&'a R);

impl<R: CommandRunner> CommandRunner for BoundedRunner<'_, R> {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        self.0.run_with_timeout(command, args, DOCKER_PAUSE_TIMEOUT)
    }
}

fn succeed<R: CommandRunner>(
    mut outcome: PauseOutcome,
    runner: &R,
    output_format: Option<&str>,
) -> ExecutionPauseResult {
    outcome.process_ids = collect_process_ids_with_runner(outcome.record, &BoundedRunner(runner));
    ExecutionPauseResult {
        success: true,
        output: Some(format_pause_report(
            &build_pause_report(&outcome),
            output_format,
        )),
        error: None,
    }
}

fn run_docker<R: CommandRunner>(runner: &R, verb: &str, name: &str) -> CommandRunOutput {
    runner.run_with_timeout(
        &docker_command().to_string_lossy(),
        &[verb.to_string(), name.to_string()],
        DOCKER_PAUSE_TIMEOUT,
    )
}

/// Handle a container Docker no longer has: record the removal and drop a
/// stale pause, then fail with a recovery path.
fn fail_removed(
    store: &ExecutionStore,
    action: PauseAction,
    identifier: &str,
    record: &ExecutionRecord,
    state: &PauseState,
) -> ExecutionPauseResult {
    // Reported either way; `--status` observes the removal again.
    let _ = store.mark_container_removed(&record.uuid, &now());
    reconcile_stale_pause(store, record, "reconcile");
    ExecutionPauseResult::fail(not_pausable_error(action, identifier, record, state))
}

/// Shared first steps: resolve the record and ask Docker about it.
fn inspect_target<'s, R: CommandRunner>(
    store: Option<&'s ExecutionStore>,
    identifier: &str,
    action: PauseAction,
    runner: &R,
) -> Result<(&'s ExecutionStore, ExecutionRecord, PauseState), ExecutionPauseResult> {
    let (store, record) =
        resolve_pause_target(store, identifier, action).map_err(ExecutionPauseResult::fail)?;
    let name = option_str(&record.options, "sessionName")
        .unwrap_or_default()
        .to_string();
    let state = inspect_pause_state(&name, runner);
    if state.state == docker_state::REMOVED {
        return Err(fail_removed(store, action, identifier, &record, &state));
    }
    if state.state == docker_state::UNKNOWN {
        return Err(ExecutionPauseResult::fail(format!(
            "Cannot {} {}: docker inspect {} failed: {}",
            action.as_str(),
            identifier,
            name,
            state.detail.as_deref().unwrap_or("unknown error")
        )));
    }
    Ok((store, record, state))
}

/// `$ --pause <id>`: freeze a running detached Docker execution.
pub fn pause_execution(
    store: Option<&ExecutionStore>,
    identifier: &str,
    request: PauseRequest,
) -> ExecutionPauseResult {
    pause_execution_with_runner(store, identifier, request, &SystemCommandRunner)
}

pub fn pause_execution_with_runner<R: CommandRunner>(
    store: Option<&ExecutionStore>,
    identifier: &str,
    request: PauseRequest,
    runner: &R,
) -> ExecutionPauseResult {
    let action = PauseAction::Pause;
    let (store, record, state) = match inspect_target(store, identifier, action, runner) {
        Ok(target) => target,
        Err(result) => return result,
    };
    let name = option_str(&record.options, "sessionName")
        .unwrap_or_default()
        .to_string();
    let pause = |options: &Options| paused_options(options, request.reason, request.by, None);

    if state.paused {
        let record = if is_paused_option(&record.options) {
            record
        } else {
            // Paused outside start-command: adopt it so status and cleanup know.
            match save_options(store, &record, pause, true) {
                Ok(saved) => saved,
                Err(error) => return ExecutionPauseResult::fail(error),
            }
        };
        let outcome = PauseOutcome {
            action,
            identifier,
            record: &record,
            status: "already-paused",
            method: "NONE",
            docker_state: docker_state::PAUSED,
            process_ids: None,
            message: format!("Container {} is already paused; nothing changed.", name),
        };
        return succeed(outcome, runner, request.output_format);
    }
    if state.state != docker_state::RUNNING {
        reconcile_stale_pause(store, &record, "reconcile");
        return ExecutionPauseResult::fail(not_pausable_error(action, identifier, &record, &state));
    }

    let result = run_docker(runner, "pause", &name);
    if !result.success {
        return ExecutionPauseResult::fail(format!(
            "Failed to pause docker container \"{}\": {}",
            name,
            failure_detail(&result)
        ));
    }
    let record = match save_options(store, &record, pause, true) {
        Ok(saved) => saved,
        Err(error) => return ExecutionPauseResult::fail(error),
    };
    let message = format!(
        "Paused detached docker container: {name}. CPU is released; memory stays allocated \
         (use `$ --stop {uuid}` to free it). `$ --unpause {uuid}` continues the same process.",
        uuid = record.uuid
    );
    let outcome = PauseOutcome {
        action,
        identifier,
        record: &record,
        status: "paused",
        method: "DOCKER_PAUSE",
        docker_state: docker_state::PAUSED,
        process_ids: None,
        message,
    };
    succeed(outcome, runner, request.output_format)
}

/// `$ --unpause <id>`: thaw a paused detached Docker execution.
pub fn unpause_execution(
    store: Option<&ExecutionStore>,
    identifier: &str,
    output_format: Option<&str>,
) -> ExecutionPauseResult {
    unpause_execution_with_runner(store, identifier, output_format, &SystemCommandRunner)
}

pub fn unpause_execution_with_runner<R: CommandRunner>(
    store: Option<&ExecutionStore>,
    identifier: &str,
    output_format: Option<&str>,
    runner: &R,
) -> ExecutionPauseResult {
    let action = PauseAction::Unpause;
    let (store, record, state) = match inspect_target(store, identifier, action, runner) {
        Ok(target) => target,
        Err(result) => return result,
    };
    let name = option_str(&record.options, "sessionName")
        .unwrap_or_default()
        .to_string();

    if state.state == docker_state::RUNNING {
        // Thawed by hand or by a daemon restart: report the truth.
        let record = reconcile_stale_pause(store, &record, "reconcile");
        let outcome = PauseOutcome {
            action,
            identifier,
            record: &record,
            status: "not-paused",
            method: "NONE",
            docker_state: docker_state::RUNNING,
            process_ids: None,
            message: format!(
                "Container {} is running and not paused; nothing changed.",
                name
            ),
        };
        return succeed(outcome, runner, output_format);
    }
    if !state.paused {
        reconcile_stale_pause(store, &record, "reconcile");
        return ExecutionPauseResult::fail(not_pausable_error(action, identifier, &record, &state));
    }

    let result = run_docker(runner, "unpause", &name);
    if !result.success {
        return ExecutionPauseResult::fail(format!(
            "Failed to unpause docker container \"{}\": {}",
            name,
            failure_detail(&result)
        ));
    }
    let record = match save_options(
        store,
        &record,
        |options| cleared_pause_options(options, "unpause", None),
        true,
    ) {
        Ok(saved) => saved,
        Err(error) => return ExecutionPauseResult::fail(error),
    };
    let outcome = PauseOutcome {
        action,
        identifier,
        record: &record,
        status: "unpaused",
        method: "DOCKER_UNPAUSE",
        docker_state: docker_state::RUNNING,
        process_ids: None,
        message: format!(
            "Unpaused detached docker container: {}. The same process continues.",
            name
        ),
    };
    succeed(outcome, runner, output_format)
}

/// The Docker state `--status` and `--list` report for a detached Docker
/// execution, or `None` for records that are not detached Docker executions.
pub fn observed_docker_state<R: CommandRunner + ?Sized>(
    record: &ExecutionRecord,
    runner: &R,
) -> Option<String> {
    if !is_detached_docker(record) {
        return None;
    }
    if is_marked_removed(record) {
        return Some(docker_state::REMOVED.to_string());
    }
    let Some(name) = option_str(&record.options, "sessionName") else {
        return Some(docker_state::UNKNOWN.to_string());
    };
    Some(inspect_pause_state(name, runner).state)
}

/// Attach `dockerState`, `paused` and `pausedAt` to a status record, and make
/// its recorded pause agree with Docker (issue #263). Unknown liveness (docker
/// unreachable) keeps the recorded pause.
pub fn attach_pause_state_with_state(
    mut record: ExecutionRecord,
    observed: Option<String>,
) -> ExecutionRecord {
    let Some(state) = observed else {
        return record;
    };
    let recorded = is_paused_option(&record.options);
    let paused = if state == docker_state::UNKNOWN {
        recorded
    } else {
        state == docker_state::PAUSED
    };
    if state != docker_state::UNKNOWN {
        if paused && !recorded {
            record.options = paused_options(&record.options, None, None, None);
        } else if !paused && recorded {
            record.options = cleared_pause_options(&record.options, "reconcile", None);
        }
    }
    record.paused_at = paused
        .then(|| option_str(&record.options, "pausedAt").map(str::to_string))
        .flatten();
    record.docker_state = Some(state);
    record.paused = Some(paused);
    record
}

/// [`attach_pause_state_with_state`] with the live Docker state.
pub fn attach_pause_state(record: ExecutionRecord) -> ExecutionRecord {
    let observed = observed_docker_state(&record, &SystemCommandRunner);
    attach_pause_state_with_state(record, observed)
}

/// Persist the pause reconciliation `--status` / `--list` observed, best
/// effort: a read-only query must never fail because the store is busy.
pub fn persist_pause_reconciliation(
    store: &ExecutionStore,
    stored: &ExecutionRecord,
    reported: &ExecutionRecord,
) {
    let target = is_paused_option(&reported.options);
    if reported.docker_state.is_none() || target == is_paused_option(&stored.options) {
        return;
    }
    let at = option_str(
        &reported.options,
        if target { "pausedAt" } else { "unpausedAt" },
    )
    .map(str::to_string);
    let _ = save_options(
        store,
        stored,
        |options| {
            if target {
                paused_options(options, None, None, at.as_deref())
            } else {
                cleared_pause_options(options, "reconcile", at.as_deref())
            }
        },
        false,
    );
}

/// Human-readable pause lines for `--status --output-format text`.
pub fn pause_text_lines(record: &ExecutionRecord) -> Vec<String> {
    let Some(state) = &record.docker_state else {
        return Vec::new();
    };
    let paused = record.paused == Some(true);
    let mut lines = vec![
        format!("Docker State:      {}", state),
        format!("Paused:            {}", paused),
    ];
    if paused {
        lines.push(format!(
            "Paused At:         {}",
            record.paused_at.as_deref().unwrap_or("N/A")
        ));
    }
    lines
}
