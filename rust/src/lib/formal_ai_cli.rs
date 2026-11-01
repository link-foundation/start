//! CLI side of the experimental `--use-formal-ai` mode (issue #255): resolves
//! the bounds and the runtime, tracks the execution like a direct run (start
//! and finish blocks, log, execution record, START_* environment) and writes
//! the evidence of the run into its log. Mirrors js/src/lib/formal-ai-cli.js.
//!
//! The log stays local: this mode never creates issues or uploads logs.

use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::args_parser::WrapperOptions;
use crate::args_parser_queries::active_query_modes;
use crate::execution_store::{ExecutionRecord, ExecutionRecordOptions, ExecutionStore};
use crate::formal_ai::{run_formal_ai_task, Outcome, TaskOptions};
use crate::formal_ai_client::{CompletionClient, HttpClient};
use crate::formal_ai_policy::{resolve_bounds_with, EXIT_CONFIG, EXIT_UNAVAILABLE, EXIT_USAGE};
use crate::formal_ai_runtime::{describe_identity, start_runtime};
use crate::isolation::{append_log_file, get_timestamp};
use crate::launch_identity::{
    apply_launch, claim_launch, direct_execution_env, write_launch_log, ClaimError, LaunchPlan,
};
use crate::output_blocks::{
    create_finish_block, create_start_block, FinishBlockOptions, StartBlockOptions,
};
use crate::signal_handler::{get_signal_exit_code, set_deferred_signals, was_signal_received};

pub const EVIDENCE_SCHEMA: &str = "start-formal-ai-evidence/1";
const PREFIX: &str = "[formal-ai]";

/// `--use-formal-ai` runs its tool calls directly in the current directory;
/// other execution modes would change where and how they run.
pub fn validate_options(options: &WrapperOptions) -> Result<(), String> {
    if !options.use_formal_ai {
        return Ok(());
    }
    let mut conflicts: Vec<&str> = Vec::new();
    if options.isolated.is_some() {
        conflicts.push("--isolated");
    }
    if options.user {
        conflicts.push("--isolated-user");
    }
    if options.detached {
        conflicts.push("--detached");
    }
    if options.use_command_stream {
        conflicts.push("--use-command-stream");
    }
    conflicts.extend(active_query_modes(options));
    if conflicts.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "--use-formal-ai cannot be combined with {} (experimental mode, see docs/formal-ai.md)",
            conflicts.join(", ")
        ))
    }
}

/// Text of the request: the argv after `--`, joined by single spaces. It is
/// only ever sent to Formal AI, never to a shell.
pub fn request_text(raw_command: &[String]) -> String {
    raw_command.join(" ").trim().to_string()
}

/// `[formal-ai] ` before every line, without trailing spaces.
pub fn prefix_lines(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            format!("{} {}", PREFIX, line)
                .trim_end_matches(' ')
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn note(text: &str) {
    eprintln!("{}", prefix_lines(text));
}

/// What `run_formal_ai_cli` needs from the CLI.
pub struct CliOptions<'a> {
    pub request: &'a str,
    pub session_id: &'a str,
    pub launch: &'a LaunchPlan,
    pub store: Option<&'a ExecutionStore>,
    pub verbose: bool,
    pub cwd: &'a Path,
    pub get_env: &'a dyn Fn(&str) -> Option<String>,
}

/// Run `--use-formal-ai` and return the exit status.
pub fn run_formal_ai_cli(options: &CliOptions<'_>) -> i32 {
    let request = options.request;
    let session_id = options.session_id;
    let bounds = match resolve_bounds_with(options.get_env) {
        Ok(bounds) => bounds,
        Err(message) => {
            note(&format!("Error: {}", message));
            return EXIT_CONFIG;
        }
    };
    if request.is_empty() {
        note("Error: --use-formal-ai needs a request after --");
        return EXIT_USAGE;
    }
    // Characters as JavaScript counts them (UTF-16 code units).
    let length = request.encode_utf16().count() as u64;
    if length > bounds.max_request_chars {
        note(&format!(
            "Error: the request has {} characters; START_FORMAL_AI_MAX_REQUEST_CHARS is {}",
            length, bounds.max_request_chars
        ));
        return EXIT_USAGE;
    }
    // Signals only record their status from here on; the loop stops the
    // tool's process group and the runtime, then finishes the evidence.
    set_deferred_signals(true);
    let cancel_code = || was_signal_received().then(get_signal_exit_code);
    let deadline = Instant::now() + Duration::from_millis(bounds.timeout_ms);
    let mut runtime = match start_runtime(options.get_env, &bounds, &was_signal_received) {
        Ok(runtime) => runtime,
        Err(message) => {
            note(&format!("Error: {}", message));
            note("No command was run: --use-formal-ai never falls back to aliases, a shell or an LLM.");
            return cancel_code().unwrap_or(EXIT_UNAVAILABLE);
        }
    };
    let identity = describe_identity(&runtime.identity);
    note(&format!("runtime: {}", identity));
    note(&format!("effects: {}", bounds.effects));

    let cwd_text = options.cwd.to_string_lossy().to_string();
    let log_path = options.launch.log_path.clone();
    let start_time = get_timestamp();
    let started = Instant::now();
    let mut record = options.store.map(|_| {
        let mut extra = HashMap::new();
        extra.insert(
            "formalAi".to_string(),
            json!({
                "request": request,
                "effects": bounds.effects,
                "runtime": runtime.identity.to_json(),
            }),
        );
        ExecutionRecord::with_options(ExecutionRecordOptions {
            uuid: Some(session_id.to_string()),
            command: request.to_string(),
            log_path: Some(log_path.to_string_lossy().to_string()),
            pid: Some(std::process::id()),
            shell: Some("formal-ai".to_string()),
            working_directory: Some(cwd_text.clone()),
            options: Some(extra),
            ..Default::default()
        })
    });
    if let (Some(record), Some(store)) = (record.as_mut(), options.store) {
        apply_launch(record, options.launch);
        if let Err(error) = claim_launch(store, record, options.launch) {
            match error {
                ClaimError::Refused(message) => {
                    note(&format!("Error: {}", message));
                    return 1;
                }
                ClaimError::Store(message) => {
                    if options.verbose {
                        note(&format!(
                            "[ExecutionStore] Warning: Failed to save initial record: {}",
                            message
                        ));
                    }
                }
            }
        }
    }
    let header = [
        "=== Start Command Log ===".to_string(),
        format!("Timestamp: {}", start_time),
        format!("Session ID: {}", session_id),
        "Mode: --use-formal-ai (experimental)".to_string(),
        format!("Request: {}", request),
        format!("Formal AI: {}", identity),
        format!("Effects: {}", bounds.effects),
        format!("Platform: {}", std::env::consts::OS),
        format!("Working Directory: {}", cwd_text),
        "=".repeat(50),
        String::new(),
        String::new(),
    ]
    .join("\n");
    write_launch_log(&log_path, &header, options.launch, record.as_ref());

    let command = format!("--use-formal-ai -- {}", request);
    println!(
        "{}",
        create_start_block(&StartBlockOptions {
            session_id,
            timestamp: &start_time,
            command: &command,
            extra_lines: None,
            style: None,
            width: None,
            defer_command: false,
        })
    );
    println!();

    let mut evidence = json!({
        "schema": EVIDENCE_SCHEMA,
        "sessionId": session_id,
        "runtime": runtime.identity.to_json(),
    });
    let env = direct_execution_env(session_id, options.launch);
    let task_note = |text: &str| {
        note(text);
        append_log_file(&log_path, &format!("{} {}\n", PREFIX, text));
    };
    let mut client = HttpClient::new(&runtime.base_url, bounds.max_retries, deadline);
    let task = panic::catch_unwind(AssertUnwindSafe(|| {
        run_formal_ai_task(
            &TaskOptions {
                request,
                cwd: options.cwd,
                env: &env,
                bounds: &bounds,
                deadline,
                mirror: true,
                note: &task_note,
                cancel: &cancel_code,
            },
            &mut client,
            &mut evidence,
        )
    }));
    let outcome = match task {
        Ok(outcome) => {
            evidence["formalAiRequests"] = json!(client.requests());
            outcome
        }
        Err(payload) => {
            let message = payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "internal error".to_string());
            let outcome = Outcome::new(
                "internal-error",
                1,
                message,
                &["start failed; the task state is unknown"],
            );
            evidence["outcome"] = outcome.to_json();
            outcome
        }
    };
    runtime.stop();
    note(&format!("{}: {}", outcome.status, outcome.message));
    for obligation in &outcome.remaining {
        note(&format!("remaining: {}", obligation));
    }
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    evidence["durationMs"] = json!(duration_ms.round() as u64);
    let end_time = get_timestamp();
    let pretty = serde_json::to_string_pretty(&evidence).unwrap_or_else(|_| evidence.to_string());
    append_log_file(
        &log_path,
        &format!(
            "\n=== Formal AI Evidence ===\n{}\n\n{}\nFinished: {}\nExit Code: {}\n",
            pretty,
            "=".repeat(50),
            end_time,
            outcome.exit_code
        ),
    );
    if let (Some(mut record), Some(store)) = (record, options.store) {
        if let Some(Value::Object(formal_ai)) = record.options.get_mut("formalAi") {
            formal_ai.insert("outcome".to_string(), json!(outcome.status));
        }
        record.complete(outcome.exit_code);
        if let Err(error) = store.save(&record) {
            if options.verbose {
                note(&format!(
                    "[Tracking] Warning: Could not save execution record: {}",
                    error
                ));
            }
        }
    }
    println!();
    println!(
        "{}",
        create_finish_block(&FinishBlockOptions {
            session_id,
            timestamp: &end_time,
            exit_code: outcome.exit_code,
            log_path: &log_path.to_string_lossy(),
            duration_ms: Some(duration_ms),
            result_message: None,
            extra_lines: None,
            style: None,
            width: None,
        })
    );
    outcome.exit_code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_text_joins_the_argv_after_the_separator() {
        let argv: Vec<String> = ["print", "list", "of", "files", ""]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(request_text(&argv), "print list of files");
        assert_eq!(request_text(&[]), "");
    }

    #[test]
    fn notes_are_prefixed_per_line_without_trailing_spaces() {
        assert_eq!(
            prefix_lines("a\n\nb "),
            "[formal-ai] a\n[formal-ai]\n[formal-ai] b"
        );
    }

    #[test]
    fn validation_rejects_modes_that_change_where_tools_run() {
        let mut options = WrapperOptions {
            use_formal_ai: true,
            ..WrapperOptions::default()
        };
        assert!(validate_options(&options).is_ok());
        options.isolated = Some("docker".to_string());
        options.detached = true;
        assert_eq!(
            validate_options(&options).unwrap_err(),
            "--use-formal-ai cannot be combined with --isolated, --detached (experimental mode, see docs/formal-ai.md)"
        );
        options.use_formal_ai = false;
        assert!(validate_options(&options).is_ok());
    }
}
