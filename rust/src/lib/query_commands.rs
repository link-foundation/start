//! Query and control command handlers.
//!
//! Every option in this module addresses an execution that already exists in
//! the tracking store instead of launching a new one: `--status`, `--list`,
//! `--upload-log`, `--stop`, `--terminate`, `--attach`, `--resume`,
//! `--resume-all` and `--cleanup`. `dispatch_query_command` is the single entry
//! point the CLI calls before it starts interpreting the command line as a
//! command to run (issue #162).

use crate::args_parser::WrapperOptions;
use crate::execution_attach::{attach_execution, ExecutionAttachResult};
use crate::execution_control::{control_execution, ControlAction, ExecutionControlResult};
use crate::execution_resume::{resume_execution, ExecutionResumeResult};
use crate::execution_resume_all::{resume_all_executions, ExecutionResumeAllResult};
use crate::execution_store::{CleanupOptions, ExecutionStore};
use crate::log_uploader::upload_execution_log;
use crate::status_formatter::{list_executions_filtered, query_status, StatusQueryResult};

/// Uniform shape every query handler reports back.
pub struct QueryOutcome {
    pub success: bool,
    pub output: Option<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
}

impl From<StatusQueryResult> for QueryOutcome {
    fn from(result: StatusQueryResult) -> Self {
        QueryOutcome {
            success: result.success,
            output: result.output,
            error: result.error,
            exit_code: None,
        }
    }
}

impl From<ExecutionControlResult> for QueryOutcome {
    fn from(result: ExecutionControlResult) -> Self {
        QueryOutcome {
            success: result.success,
            output: result.output,
            error: result.error,
            exit_code: None,
        }
    }
}

impl From<ExecutionAttachResult> for QueryOutcome {
    fn from(result: ExecutionAttachResult) -> Self {
        QueryOutcome {
            success: result.success,
            output: result.output,
            error: result.error,
            exit_code: result.exit_code,
        }
    }
}

impl From<ExecutionResumeResult> for QueryOutcome {
    fn from(result: ExecutionResumeResult) -> Self {
        QueryOutcome {
            success: result.success,
            output: result.output,
            error: result.error,
            exit_code: None,
        }
    }
}

impl From<ExecutionResumeAllResult> for QueryOutcome {
    fn from(result: ExecutionResumeAllResult) -> Self {
        QueryOutcome {
            success: result.success,
            output: result.output,
            error: result.error,
            exit_code: None,
        }
    }
}

/// Print a handler result, returning the process exit code.
pub fn report_result(result: QueryOutcome) -> i32 {
    if result.success {
        if let Some(output) = result.output {
            println!("{}", output);
        }
        return result.exit_code.unwrap_or(0);
    }
    if let Some(error) = result.error {
        eprintln!("Error: {}", error);
    }
    result.exit_code.unwrap_or(1)
}

/// Handle `--upload-log`, which reports its own exit code.
pub fn handle_upload_log_query(store: Option<&ExecutionStore>, identifier: &str) -> i32 {
    match upload_execution_log(store, identifier) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {}", error);
            1
        }
    }
}

/// Handle `--cleanup` / `--cleanup-dry-run`.
///
/// Cleans up stale "executing" records (processes that crashed or were killed).
pub fn handle_cleanup(store: Option<&ExecutionStore>, dry_run: bool) -> i32 {
    let Some(store) = store else {
        eprintln!("Error: Execution tracking is disabled.");
        return 1;
    };

    let result = store.cleanup_stale(CleanupOptions {
        dry_run,
        ..Default::default()
    });

    for error in &result.errors {
        eprintln!("Error: {}", error);
    }

    if result.records.is_empty() {
        println!("No stale records found.");
        return 0;
    }

    if dry_run {
        println!(
            "Found {} stale record(s) that would be cleaned up:\n",
            result.records.len()
        );
    } else {
        println!("Cleaned up {} stale record(s):\n", result.cleaned);
    }

    for record in &result.records {
        let start_time_display = chrono::DateTime::parse_from_rfc3339(&record.start_time)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|_| record.start_time.clone());

        println!("  UUID: {}", record.uuid);
        println!("  Command: {}", record.command);
        println!("  Started: {}", start_time_display);
        println!(
            "  PID: {}",
            record
                .pid
                .map(|p| p.to_string())
                .unwrap_or("N/A".to_string())
        );
        println!();
    }

    if dry_run {
        println!("Run with --cleanup to actually clean up these records.");
    }
    0
}

/// Run the query/control mode selected by the wrapper options, if any.
///
/// Returns the process exit code, or `None` when no query mode is active and
/// the invocation should be treated as a command to run.
pub fn dispatch_query_command(
    options: &WrapperOptions,
    store: Option<&ExecutionStore>,
    command: &str,
) -> Option<i32> {
    let output_format = options.output_format.as_deref();

    if let Some(ref identifier) = options.status {
        return Some(report_result(
            query_status(store, identifier, output_format).into(),
        ));
    }
    if options.list {
        return Some(report_result(
            list_executions_filtered(store, output_format, options.running).into(),
        ));
    }
    if let Some(ref identifier) = options.upload_log {
        return Some(handle_upload_log_query(store, identifier));
    }
    if let Some(ref identifier) = options.stop {
        return Some(report_result(
            control_execution(store, identifier, ControlAction::Stop).into(),
        ));
    }
    if let Some(ref identifier) = options.terminate {
        return Some(report_result(
            control_execution(store, identifier, ControlAction::Terminate).into(),
        ));
    }
    if let Some(ref identifier) = options.attach {
        return Some(report_result(
            attach_execution(store, identifier, options.read_only).into(),
        ));
    }
    if let Some(ref identifier) = options.resume {
        let new_command = if command.trim().is_empty() {
            None
        } else {
            Some(command)
        };
        return Some(report_result(
            resume_execution(store, identifier, new_command, output_format).into(),
        ));
    }
    if options.resume_all {
        return Some(report_result(
            resume_all_executions(store, output_format).into(),
        ));
    }
    if options.cleanup {
        return Some(handle_cleanup(store, options.cleanup_dry_run));
    }

    None
}
