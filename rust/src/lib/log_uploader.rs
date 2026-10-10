//! Helpers for uploading tracked execution logs.

use std::path::Path;

use crate::execution_store::ExecutionStore;
use crate::failure_handler::upload_log_interactive_with_options;

/// Upload the log for a stored execution by UUID or session name.
pub fn upload_execution_log(
    store: Option<&ExecutionStore>,
    identifier: &str,
) -> Result<i32, String> {
    upload_execution_log_with_options(store, identifier, false, false)
}

/// Upload a stored log with an explicit sanitization opt-out and diagnostics.
pub fn upload_execution_log_with_options(
    store: Option<&ExecutionStore>,
    identifier: &str,
    no_sanitize: bool,
    verbose: bool,
) -> Result<i32, String> {
    let store = store.ok_or_else(|| "Execution tracking is disabled.".to_string())?;
    let record = store.get(identifier).ok_or_else(|| {
        format!(
            "No execution found with UUID or session name: {}",
            identifier
        )
    })?;

    if record.log_path.is_empty() {
        return Err("Execution record does not have a log path.".to_string());
    }

    if !Path::new(&record.log_path).exists() {
        return Err(format!("Log file not found: {}", record.log_path));
    }

    upload_log_interactive_with_options(&record.log_path, no_sanitize, verbose)
}
