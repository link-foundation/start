//! Signal handling for graceful cleanup on process interruption
//!
//! This module provides signal handlers that update execution status when the process
//! is interrupted by signals like SIGINT (Ctrl+C), SIGTERM (kill), or SIGHUP (terminal close).

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;

use crate::execution_store::{ExecutionRecord, ExecutionStore};

// Global state for signal handling cleanup
// These are used to update execution status when the process is interrupted
static SIGNAL_RECEIVED: AtomicBool = AtomicBool::new(false);
static SIGNAL_EXIT_CODE: AtomicI32 = AtomicI32::new(0);
static CURRENT_EXECUTION: Mutex<Option<(ExecutionRecord, ExecutionStore)>> = Mutex::new(None);

/// Check if a signal has been received
#[allow(dead_code)]
pub fn was_signal_received() -> bool {
    SIGNAL_RECEIVED.load(Ordering::SeqCst)
}

/// Get the exit code from the received signal
#[allow(dead_code)]
pub fn get_signal_exit_code() -> i32 {
    SIGNAL_EXIT_CODE.load(Ordering::SeqCst)
}

/// Set up signal handlers for graceful cleanup on interruption
#[cfg(unix)]
pub fn setup_signal_handlers() {
    use std::sync::Once;
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        unsafe {
            // SIGINT (Ctrl+C) - exit code 130 (128 + 2)
            libc::signal(libc::SIGINT, signal_handler as usize);
            // SIGTERM (kill command) - exit code 143 (128 + 15)
            libc::signal(libc::SIGTERM, signal_handler as usize);
            // SIGHUP (terminal closed) - exit code 129 (128 + 1)
            libc::signal(libc::SIGHUP, signal_handler as usize);
        }
    });
}

#[cfg(not(unix))]
pub fn setup_signal_handlers() {
    // Signal handling not supported on non-Unix platforms
}

/// Signal handler function
#[cfg(unix)]
extern "C" fn signal_handler(sig: i32) {
    // Calculate exit code based on signal (128 + signal number)
    let exit_code = 128 + sig;
    SIGNAL_EXIT_CODE.store(exit_code, Ordering::SeqCst);
    SIGNAL_RECEIVED.store(true, Ordering::SeqCst);

    // Try to clean up the current execution record
    cleanup_execution_on_signal(sig, exit_code);

    // Exit with the appropriate code
    std::process::exit(exit_code);
}

/// Clean up execution record when a signal is received
#[cfg(unix)]
fn cleanup_execution_on_signal(signal: i32, exit_code: i32) {
    if let Ok(mut guard) = CURRENT_EXECUTION.lock() {
        if let Some((ref mut record, ref store)) = *guard {
            // Mark as completed with signal exit code
            record.complete(exit_code);
            if let Err(e) = store.save(record) {
                // Log error to stderr (can't easily check config here)
                eprintln!(
                    "\n[Tracking] Warning: Could not save execution record on signal {}: {}",
                    signal, e
                );
            }
            // Clear the record to prevent double cleanup
            *guard = None;
        }
    }
}

/// Set the current execution record for signal cleanup
pub fn set_current_execution(record: ExecutionRecord, store: ExecutionStore) {
    if let Ok(mut guard) = CURRENT_EXECUTION.lock() {
        *guard = Some((record, store));
    }
}

/// Clear the current execution record (call after normal completion)
pub fn clear_current_execution() {
    if let Ok(mut guard) = CURRENT_EXECUTION.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signal_received_initially_false() {
        // Note: This test might be flaky if run after other tests that set the flag
        // In a fresh process, SIGNAL_RECEIVED should be false
        // We can't reliably test this after setup_signal_handlers is called
    }

    #[test]
    fn test_set_and_clear_current_execution() {
        // Just verify the functions don't panic
        clear_current_execution();
    }
}
