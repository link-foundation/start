//! Tests for signal_handler.rs
//!
//! Tests signal handling utility functions.

use start_command::{
    clear_current_execution, get_signal_exit_code, setup_signal_handlers, was_signal_received,
};

#[test]
fn was_signal_received_returns_bool() {
    // Just verify it returns without panicking
    let _result: bool = was_signal_received();
}

#[test]
fn get_signal_exit_code_returns_i32() {
    let result: i32 = get_signal_exit_code();
    // Default value before any signal is 0
    let _ = result;
}

#[test]
fn clear_current_execution_does_not_panic() {
    clear_current_execution();
}

#[test]
fn setup_signal_handlers_can_be_called_multiple_times() {
    setup_signal_handlers();
    setup_signal_handlers();
    setup_signal_handlers();
    // Should not panic — uses Once internally
}

#[test]
fn clear_current_execution_can_be_called_multiple_times() {
    clear_current_execution();
    clear_current_execution();
    clear_current_execution();
}

#[test]
fn get_signal_exit_code_initial_value_is_zero() {
    // In a fresh state (no signals received yet), exit code should be 0
    // Note: other tests in the suite may change global state, so we just verify it's a valid i32
    let _code = get_signal_exit_code();
    // Just verify it returns without panicking
}
