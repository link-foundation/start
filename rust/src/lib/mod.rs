//! start-command library
//!
//! Provides command execution with isolation, substitution, and failure handling.

pub mod args_parser;
pub mod execution_store;
pub mod failure_handler;
pub mod isolation;
pub mod output_blocks;
pub mod signal_handler;
pub mod status_formatter;
pub mod substitution;
pub mod user_manager;

// Re-export commonly used items
pub use args_parser::{
    generate_session_name, generate_uuid, get_effective_mode, has_isolation, is_valid_uuid,
    parse_args, validate_options, ParsedArgs, WrapperOptions, VALID_BACKENDS, VALID_OUTPUT_FORMATS,
};
pub use execution_store::{
    is_clink_installed, CleanupOptions, CleanupResult, ExecutionRecord, ExecutionRecordOptions,
    ExecutionStats, ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
};
pub use failure_handler::{handle_failure, Config as FailureConfig};
pub use isolation::{
    create_log_footer, create_log_header, create_log_path, get_default_docker_image, get_timestamp,
    is_command_available, run_as_isolated_user, run_isolated, write_log_file, IsolationOptions,
    IsolationResult, LogHeaderParams,
};
pub use output_blocks::{
    // New status spine format (primary API)
    create_command_line,
    create_empty_spine_line,
    // Main block creation functions (updated for spine format)
    create_finish_block,
    create_spine_line,
    create_start_block,
    // Legacy box format (deprecated, kept for backward compatibility)
    escape_for_links_notation,
    format_duration,
    format_value_for_links_notation,
    generate_isolation_lines,
    get_box_style,
    get_result_marker,
    parse_isolation_metadata,
    BoxStyle,
    FinishBlockOptions,
    IsolationMetadata,
    StartBlockOptions,
    DEFAULT_WIDTH,
    FAILURE_MARKER,
    SPINE,
    SUCCESS_MARKER,
};
pub use signal_handler::{clear_current_execution, set_current_execution, setup_signal_handlers};
pub use status_formatter::{
    format_record, format_record_as_links_notation, format_record_as_text, query_status,
    StatusQueryResult,
};
pub use substitution::{process_command, ProcessOptions, SubstitutionResult};
pub use user_manager::{
    create_isolated_user, delete_user, get_current_user, get_current_user_groups, has_sudo_access,
    CreateIsolatedUserOptions, DeleteUserOptions, UserOperationResult,
};
