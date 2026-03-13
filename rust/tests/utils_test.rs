//! Tests for utility functions: generate_uuid, generate_session_name, is_valid_uuid.
//!
//! Mirrors the utility test coverage from the JS test suite.

use start_command::{generate_session_name, generate_uuid, is_valid_uuid};

mod generate_uuid_tests {
    use super::*;

    #[test]
    fn should_return_a_non_empty_string() {
        let id = generate_uuid();
        assert!(!id.is_empty());
    }

    #[test]
    fn should_return_a_string_matching_uuid_v4_format() {
        let id = generate_uuid();
        // UUID v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5, "UUID should have 5 hyphen-separated parts: {}", id);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 4);
        assert_eq!(parts[2].len(), 4);
        assert_eq!(parts[3].len(), 4);
        assert_eq!(parts[4].len(), 12);
    }

    #[test]
    fn should_return_unique_uuids() {
        let id1 = generate_uuid();
        let id2 = generate_uuid();
        assert_ne!(id1, id2, "Each UUID should be unique");
    }

    #[test]
    fn should_pass_is_valid_uuid_check() {
        let id = generate_uuid();
        assert!(is_valid_uuid(&id), "Generated UUID should be valid: {}", id);
    }
}

mod is_valid_uuid_tests {
    use super::*;

    #[test]
    fn should_return_true_for_valid_uuid() {
        assert!(is_valid_uuid("550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn should_return_false_for_empty_string() {
        assert!(!is_valid_uuid(""));
    }

    #[test]
    fn should_return_false_for_non_uuid_string() {
        assert!(!is_valid_uuid("not-a-uuid"));
    }

    #[test]
    fn should_return_false_for_uuid_with_wrong_length() {
        assert!(!is_valid_uuid("550e8400-e29b-41d4-a716-44665544000"));
    }
}

mod generate_session_name_tests {
    use super::*;

    #[test]
    fn should_return_non_empty_string() {
        let name = generate_session_name(None);
        assert!(!name.is_empty());
    }

    #[test]
    fn should_use_default_prefix_start() {
        let name = generate_session_name(None);
        assert!(
            name.starts_with("start-"),
            "Should start with 'start-': {}",
            name
        );
    }

    #[test]
    fn should_use_custom_prefix() {
        let name = generate_session_name(Some("myapp"));
        assert!(
            name.starts_with("myapp-"),
            "Should start with 'myapp-': {}",
            name
        );
    }

    #[test]
    fn should_return_unique_names() {
        let name1 = generate_session_name(None);
        std::thread::sleep(std::time::Duration::from_millis(2));
        let name2 = generate_session_name(None);
        assert_ne!(name1, name2, "Session names should be unique");
    }
}
