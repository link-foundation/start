//! Tests for isolation_log.rs
//!
//! Mirrors isolation_log test coverage from the JS test suite.

use start_command::isolation::isolation_log::{
    create_log_footer, create_log_header, create_log_path, create_log_path_for_execution,
    generate_log_filename, get_default_docker_image, get_log_dir, get_temp_root, get_timestamp,
    write_log_file, LogHeaderParams,
};
use std::path::PathBuf;

mod get_timestamp_tests {
    use super::*;

    #[test]
    fn should_return_non_empty_string() {
        let ts = get_timestamp();
        assert!(!ts.is_empty());
    }

    #[test]
    fn should_contain_date_separator() {
        let ts = get_timestamp();
        // Format: "2026-03-13 12:34:56.789"
        assert!(ts.contains('-'), "Expected date separator: {}", ts);
    }

    #[test]
    fn should_contain_time_separator() {
        let ts = get_timestamp();
        assert!(ts.contains(':'), "Expected time separator: {}", ts);
    }

    #[test]
    fn should_contain_year() {
        let ts = get_timestamp();
        // Year should be present (2020s)
        assert!(ts.contains("202"), "Expected year in timestamp: {}", ts);
    }
}

mod generate_log_filename_tests {
    use super::*;

    #[test]
    fn should_contain_environment_name() {
        let filename = generate_log_filename("docker");
        assert!(
            filename.contains("docker"),
            "Expected 'docker' in filename: {}",
            filename
        );
    }

    #[test]
    fn should_end_with_dot_log() {
        let filename = generate_log_filename("screen");
        assert!(
            filename.ends_with(".log"),
            "Expected .log extension: {}",
            filename
        );
    }

    #[test]
    fn should_start_with_start_command_prefix() {
        let filename = generate_log_filename("tmux");
        assert!(
            filename.starts_with("start-command-"),
            "Expected prefix: {}",
            filename
        );
    }

    #[test]
    fn should_be_unique_for_same_environment() {
        let f1 = generate_log_filename("docker");
        // Sleep briefly to ensure different timestamps - use a thread::sleep
        std::thread::sleep(std::time::Duration::from_millis(2));
        let f2 = generate_log_filename("docker");
        // Filenames should differ (timestamp differs)
        assert_ne!(f1, f2, "Filenames should be unique");
    }
}

mod create_log_header_tests {
    use super::*;

    fn make_params() -> LogHeaderParams {
        LogHeaderParams {
            command: "npm test".to_string(),
            environment: "docker".to_string(),
            mode: "normal".to_string(),
            session_name: "test-session".to_string(),
            image: Some("ubuntu:latest".to_string()),
            user: Some("testuser".to_string()),
            start_time: "2026-03-13 10:00:00".to_string(),
        }
    }

    #[test]
    fn should_contain_start_command_log_header() {
        let header = create_log_header(&make_params());
        assert!(
            header.contains("Start Command Log"),
            "Expected header section: {}",
            header
        );
    }

    #[test]
    fn should_contain_command() {
        let header = create_log_header(&make_params());
        assert!(
            header.contains("npm test"),
            "Expected command in header: {}",
            header
        );
    }

    #[test]
    fn should_contain_environment() {
        let header = create_log_header(&make_params());
        assert!(
            header.contains("docker"),
            "Expected environment in header: {}",
            header
        );
    }

    #[test]
    fn should_contain_session_name() {
        let header = create_log_header(&make_params());
        assert!(
            header.contains("test-session"),
            "Expected session in header: {}",
            header
        );
    }

    #[test]
    fn should_contain_image_when_provided() {
        let header = create_log_header(&make_params());
        assert!(
            header.contains("ubuntu:latest"),
            "Expected image in header: {}",
            header
        );
    }

    #[test]
    fn should_contain_user_when_provided() {
        let header = create_log_header(&make_params());
        assert!(
            header.contains("testuser"),
            "Expected user in header: {}",
            header
        );
    }
}

mod create_log_footer_tests {
    use super::*;

    #[test]
    fn should_contain_exit_code() {
        let footer = create_log_footer("2026-03-13 10:01:00", 42);
        assert!(
            footer.contains("42"),
            "Expected exit code in footer: {}",
            footer
        );
    }

    #[test]
    fn should_contain_end_time() {
        let footer = create_log_footer("2026-03-13 10:01:00", 0);
        assert!(
            footer.contains("2026-03-13"),
            "Expected end time in footer: {}",
            footer
        );
    }

    #[test]
    fn should_contain_finished_label() {
        let footer = create_log_footer("2026-03-13 10:01:00", 0);
        assert!(
            footer.contains("Finished"),
            "Expected Finished label: {}",
            footer
        );
    }

    #[test]
    fn should_contain_exit_code_label() {
        let footer = create_log_footer("2026-03-13 10:01:00", 1);
        assert!(
            footer.contains("Exit Code"),
            "Expected Exit Code label: {}",
            footer
        );
    }
}

mod write_log_file_tests {
    use super::*;

    #[test]
    fn should_return_true_when_writing_to_temp_path() {
        let temp_path = std::env::temp_dir().join("test_isolation_log_write.log");
        let result = write_log_file(&temp_path, "test content");
        assert!(result, "Expected write_log_file to return true");
        // Clean up
        let _ = std::fs::remove_file(&temp_path);
    }

    #[test]
    fn should_return_false_for_invalid_path() {
        let invalid_path = PathBuf::from("/nonexistent/deeply/nested/dir/test.log");
        let result = write_log_file(&invalid_path, "content");
        assert!(
            !result,
            "Expected write_log_file to return false for invalid path"
        );
    }
}

mod get_log_dir_tests {
    use super::*;

    #[test]
    fn should_return_a_valid_path() {
        let dir = get_log_dir();
        assert!(!dir.as_os_str().is_empty(), "Expected non-empty log dir");
    }

    #[test]
    fn should_return_temp_dir_by_default() {
        // Without START_LOG_DIR env var, should use start-command's temp log root.
        let dir = get_log_dir();
        assert!(dir.ends_with("logs"));
        assert!(dir.starts_with(get_temp_root()));
    }
}

mod create_log_path_tests {
    use super::*;

    #[test]
    fn should_return_path_ending_in_dot_log() {
        let path = create_log_path("docker");
        let path_str = path.to_string_lossy();
        assert!(
            path_str.ends_with(".log"),
            "Expected .log extension: {}",
            path_str
        );
    }

    #[test]
    fn should_contain_environment_in_path() {
        let path = create_log_path("screen");
        let path_str = path.to_string_lossy();
        assert!(
            path_str.contains("screen"),
            "Expected environment in path: {}",
            path_str
        );
    }

    #[test]
    fn should_create_stable_isolation_path_for_execution_id() {
        let path = create_log_path_for_execution("screen", "uuid-123");
        let path_str = path.to_string_lossy();
        assert!(
            path_str.ends_with("logs/isolation/screen/uuid-123.log"),
            "Expected stable execution path, got: {}",
            path_str
        );
    }

    #[test]
    fn should_create_stable_direct_path_without_duplicate_environment() {
        let path = create_log_path_for_execution("direct", "uuid-123");
        let path_str = path.to_string_lossy();
        assert!(
            path_str.ends_with("logs/direct/uuid-123.log"),
            "Expected stable direct execution path, got: {}",
            path_str
        );
    }
}

mod get_default_docker_image_tests {
    use super::*;

    #[test]
    fn should_return_non_empty_string() {
        let image = get_default_docker_image();
        assert!(!image.is_empty());
    }

    #[test]
    fn should_return_image_with_tag() {
        let image = get_default_docker_image();
        assert!(image.contains(':'), "Expected tag in image name: {}", image);
    }

    #[test]
    fn should_return_known_base_image() {
        let image = get_default_docker_image();
        let known = [
            "alpine:latest",
            "ubuntu:latest",
            "debian:latest",
            "archlinux:latest",
            "fedora:latest",
            "centos:latest",
        ];
        assert!(
            known.contains(&image.as_str()),
            "Expected known base image, got: {}",
            image
        );
    }
}
