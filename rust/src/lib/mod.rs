//! start-command library
//!
//! Provides command execution with isolation, substitution, and failure handling.

pub mod args_parser;
pub mod execution_store;
pub mod failure_handler;
pub mod isolation;
pub mod substitution;
pub mod user_manager;

// Re-export commonly used items
pub use args_parser::{
    get_effective_mode, has_isolation, parse_args, validate_options, ParsedArgs, WrapperOptions,
    VALID_BACKENDS,
};
pub use execution_store::{
    is_clink_installed, ExecutionRecord, ExecutionRecordOptions, ExecutionStats, ExecutionStatus,
    ExecutionStore, ExecutionStoreOptions,
};
pub use failure_handler::{handle_failure, Config as FailureConfig};
pub use isolation::{
    create_log_footer, create_log_header, create_log_path, get_timestamp, is_command_available,
    run_as_isolated_user, run_isolated, write_log_file, IsolationOptions, IsolationResult,
    LogHeaderParams,
};
pub use substitution::{process_command, ProcessOptions, SubstitutionResult};
pub use user_manager::{
    create_isolated_user, delete_user, get_current_user, get_current_user_groups, has_sudo_access,
    CreateIsolatedUserOptions, DeleteUserOptions, UserOperationResult,
};
