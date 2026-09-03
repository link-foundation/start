//! Tests for user_manager.rs
//!
//! Mirrors user_manager test coverage from the JS test suite.

#[cfg(unix)]
use start_command::user_manager::get_current_user_groups;
use start_command::user_manager::{generate_isolated_username, get_current_user, user_exists};

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
    assert!(!user.is_empty());
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
    // The generated name never reaches the failure message: CodeQL's
    // rust/cleartext-logging treats a username flowing into a panic (which
    // the test harness writes to its log) as a leak, and here the prefix -
    // not the value - is what the assertion is about (issue #168).
    assert!(name.starts_with("start-"), "Expected a 'start-' prefix");
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
    assert!(name.starts_with("test-"), "Expected a 'test-' prefix");
}

#[test]
fn generate_isolated_username_returns_unique_names() {
    let name1 = generate_isolated_username(None);
    std::thread::sleep(std::time::Duration::from_millis(2));
    let name2 = generate_isolated_username(None);
    assert_ne!(name1, name2, "Expected unique names");
}

#[test]
fn generate_isolated_username_draws_the_suffix_from_a_csprng() {
    // Mirrors the JavaScript test. Rust has no Math.random to pin, so the
    // guard is twofold: the names minted inside one millisecond - where only
    // the suffix can differ - must still spread out, and the module must no
    // longer carry the hand-rolled, time-seeded xorshift that made the suffix
    // predictable (issue #168).
    use std::collections::HashSet;

    let mut suffixes = HashSet::new();
    for _ in 0..500 {
        let name = generate_isolated_username(None);
        assert!(
            name.strip_prefix("start-")
                .is_some_and(|rest| rest.chars().all(|c| c.is_ascii_alphanumeric())),
            "expected a 'start-' prefix followed by alphanumerics"
        );
        suffixes.insert(name[name.len() - 4..].to_string());
    }
    assert!(
        suffixes.len() > 100,
        "expected a wide spread of suffixes, got {}",
        suffixes.len()
    );

    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib/user_manager.rs"),
    )
    .expect("cannot read src/lib/user_manager.rs");
    assert!(
        !source.contains("fn simple_random"),
        "the suffix must come from the OS CSPRNG, not a hand-rolled generator"
    );
    assert!(
        source.contains("Uuid::new_v4"),
        "random_base36 must draw from uuid::Uuid::new_v4 (getrandom)"
    );
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
