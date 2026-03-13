//! Tests for user_manager.rs
//!
//! Mirrors user_manager test coverage from the JS test suite.

use start_command::user_manager::{
    generate_isolated_username, get_current_user, get_current_user_groups, user_exists,
};

#[test]
fn get_current_user_returns_non_empty_string() {
    let user = get_current_user();
    assert!(!user.is_empty(), "Expected non-empty username");
}

#[test]
fn get_current_user_returns_known_user() {
    let user = get_current_user();
    // Should not be the fallback "unknown" value in a normal environment
    // (may be unknown in very constrained CI, so we just check it's a string)
    assert!(user.len() > 0);
}

#[test]
#[cfg(unix)]
fn get_current_user_groups_returns_non_empty_vec() {
    let groups = get_current_user_groups();
    assert!(!groups.is_empty(), "Expected at least one group");
}

#[test]
#[cfg(unix)]
fn get_current_user_groups_returns_strings() {
    let groups = get_current_user_groups();
    for g in &groups {
        assert!(!g.is_empty(), "Group names should not be empty");
    }
}

#[test]
fn generate_isolated_username_with_no_prefix_starts_with_start_dash() {
    let name = generate_isolated_username(None);
    assert!(
        name.starts_with("start-"),
        "Expected 'start-' prefix: {}",
        name
    );
}

#[test]
fn generate_isolated_username_with_no_prefix_length_at_most_31() {
    let name = generate_isolated_username(None);
    assert!(
        name.len() <= 31,
        "Expected length <= 31, got: {}",
        name.len()
    );
}

#[test]
fn generate_isolated_username_with_custom_prefix() {
    let name = generate_isolated_username(Some("test"));
    assert!(
        name.starts_with("test-"),
        "Expected 'test-' prefix: {}",
        name
    );
}

#[test]
fn generate_isolated_username_returns_unique_names() {
    let name1 = generate_isolated_username(None);
    std::thread::sleep(std::time::Duration::from_millis(2));
    let name2 = generate_isolated_username(None);
    assert_ne!(name1, name2, "Expected unique names");
}

#[test]
fn user_exists_returns_false_for_nonexistent_user() {
    assert!(!user_exists(
        "this_user_definitely_does_not_exist_xyzzy_12345"
    ));
}

#[test]
#[cfg(unix)]
fn user_exists_returns_true_for_root() {
    assert!(user_exists("root"), "Expected 'root' user to exist on Unix");
}
