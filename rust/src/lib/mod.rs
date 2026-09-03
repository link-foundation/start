//! start-command library
//!
//! Provides command execution with isolation, substitution, and failure handling.

pub mod args_parser;
pub mod args_parser_queries;
pub(crate) mod docker_cleanup;
mod docker_network_lifecycle;
pub mod execution_attach;
pub mod execution_control;
pub mod execution_resume;
pub mod execution_resume_all;
pub mod execution_store;
pub mod exit_reason;
pub mod failure_handler;
pub mod isolation;
pub mod isolation_metadata;
pub mod log_uploader;
pub mod output_blocks;
pub mod query_commands;
pub mod sequence_parser;
pub mod session_probe;
pub mod signal_handler;
pub mod status_formatter;
pub mod substitution;
pub mod usage;
pub mod user_manager;

mod lino_value_json;
mod local_hostname;

// Re-export commonly used items
pub use args_parser::{
    generate_session_name, generate_uuid, get_effective_mode, has_isolation, is_valid_uuid,
    parse_args, validate_options, ParsedArgs, WrapperOptions, VALID_BACKENDS, VALID_OUTPUT_FORMATS,
    VALID_SHELLS,
};
pub use execution_attach::{
    attach_execution, attach_execution_with_runners, build_attach_plan,
    format_attach_result_as_links_notation, AttachPlan, AttachResultFields, ExecutionAttachResult,
    InteractiveRunner, SystemInteractiveRunner,
};
pub use execution_control::{
    collect_descendant_pids, collect_descendant_pids_with_runner, collect_process_ids,
    collect_process_ids_with_runner, control_execution, control_execution_with_runner,
    format_control_result_as_links_notation, get_control_command, parse_screen_pid,
    CommandRunOutput, CommandRunner, ControlAction, ControlCommand, ExecutionControlResult,
    SystemCommandRunner,
};
pub use execution_resume::{
    build_resume_plan, build_resumed_session_name, build_snapshot_image_name, resume_execution,
    resume_execution_with, ExecutionResumeResult, ResumeHooks, ResumeMode, ResumePlan,
    ResumeResultFields, SystemResumeHooks,
};
pub use execution_resume_all::{
    format_resume_all, resume_all_executions, resume_all_executions_with, ExecutionResumeAllResult,
    ResumeAllAction, ResumeAllEntry,
};
pub use execution_store::{
    is_clink_installed, CleanupOptions, CleanupResult, ExecutionRecord, ExecutionRecordOptions,
    ExecutionStats, ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
};
pub use exit_reason::{detect_exit_reason, resolve_exit_reason, signal_name_for_exit_code};
pub use failure_handler::{handle_failure, Config as FailureConfig};
pub use isolation::{
    append_log_file, build_command_string, build_display_command, build_shell_with_args_cmd_args,
    command_name, create_log_footer, create_log_header, create_log_path,
    create_log_path_for_execution, docker_image_exists, docker_pull_image,
    get_default_docker_image, get_timestamp, is_command_available, is_interactive_shell_command,
    is_shell_invocation_with_args, quote_shell_arg, run_as_isolated_user, run_isolated,
    split_shell_words, write_log_file, IsolationOptions, IsolationResult, LogHeaderParams,
};
pub use isolation_metadata::{
    build_isolation_options_map, docker_runtime_metadata, docker_runtime_status_lines,
    docker_runtime_status_lines_for_options,
};
pub use log_uploader::upload_execution_log;
#[allow(deprecated)]
pub use output_blocks::{
    // Timeline format API (formerly "status spine")
    create_command_line,
    create_empty_spine_line, // deprecated, use create_empty_timeline_line
    create_empty_timeline_line,
    create_finish_block,
    create_spine_line, // deprecated, use create_timeline_line
    create_start_block,
    create_timeline_line,
    create_timeline_separator,
    create_virtual_command_block,
    create_virtual_command_result,
    escape_for_links_notation,
    format_duration,
    format_value_for_links_notation,
    generate_isolation_lines,
    get_result_marker,
    parse_isolation_metadata,
    FinishBlockOptions,
    IsolationMetadata,
    StartBlockOptions,
    FAILURE_MARKER,
    SPINE, // deprecated, use TIMELINE_MARKER
    SUCCESS_MARKER,
    TIMELINE_MARKER,
};
pub use query_commands::{dispatch_query_command, handle_cleanup, report_result, QueryOutcome};
pub use session_probe::{probe_session, SessionProbe, SessionState};
pub use signal_handler::{
    clear_current_execution, get_signal_exit_code, set_current_execution, setup_signal_handlers,
    was_signal_received,
};
pub use status_formatter::{
    attach_current_time, enrich_detached_status, format_record, format_record_as_links_notation,
    format_record_as_links_notation_with_current_time, format_record_as_text,
    format_record_as_text_with_current_time, format_record_list,
    format_record_list_as_links_notation, format_record_list_as_text,
    format_record_with_current_time, is_detached_session_alive, list_executions,
    list_executions_filtered, query_status, read_exit_code_from_log, StatusQueryResult,
};
pub use substitution::{process_command, ProcessOptions, SubstitutionResult};
pub use usage::print_usage;
pub use user_manager::{
    create_isolated_user, delete_user, get_current_user, get_current_user_groups, has_sudo_access,
    CreateIsolatedUserOptions, DeleteUserOptions, UserOperationResult,
};
