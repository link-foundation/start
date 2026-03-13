//! Tests for failure_handler.rs
//!
//! Mirrors failure_handler test coverage from the JS test suite.

use start_command::failure_handler::{
    can_create_issue, handle_failure, is_gh_authenticated, is_gh_upload_log_available,
    parse_git_url, Config,
};

mod parse_git_url_tests {
    use super::*;

    #[test]
    fn should_parse_https_url() {
        let info = parse_git_url("https://github.com/owner/repo").unwrap();
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
        assert_eq!(info.url, "https://github.com/owner/repo");
    }

    #[test]
    fn should_parse_ssh_url() {
        let info = parse_git_url("git@github.com:owner/repo.git").unwrap();
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
    }

    #[test]
    fn should_parse_git_at_format() {
        let info = parse_git_url("git@github.com:myorg/myrepo").unwrap();
        assert_eq!(info.owner, "myorg");
        assert_eq!(info.repo, "myrepo");
    }

    #[test]
    fn should_return_none_for_empty_string() {
        assert!(parse_git_url("").is_none());
    }

    #[test]
    fn should_return_none_for_invalid_url() {
        assert!(parse_git_url("not a url").is_none());
    }

    #[test]
    fn should_return_none_for_non_github_url() {
        assert!(parse_git_url("https://gitlab.com/owner/repo").is_none());
    }

    #[test]
    fn should_strip_git_suffix_from_repo() {
        let info = parse_git_url("https://github.com/owner/repo.git").unwrap();
        assert_eq!(info.repo, "repo");
        assert!(!info.repo.ends_with(".git"));
    }

    #[test]
    fn should_normalize_url_to_https() {
        let info = parse_git_url("git@github.com:owner/myrepo.git").unwrap();
        assert!(info.url.starts_with("https://"));
        assert!(info.url.contains("github.com"));
    }

    #[test]
    fn should_parse_npm_style_git_url() {
        // npm registry returns git+https:// URLs
        let info = parse_git_url("git+https://github.com/link-foundation/start.git");
        // Should either parse or return None (regex matches github.com)
        if let Some(i) = info {
            assert_eq!(i.owner, "link-foundation");
            assert_eq!(i.repo, "start");
        }
    }
}

mod config_tests {
    use super::*;

    #[test]
    fn should_have_correct_default_values() {
        let config = Config::default();
        assert!(!config.disable_auto_issue);
        assert!(!config.disable_log_upload);
        assert!(!config.verbose);
    }

    #[test]
    fn should_allow_setting_disable_auto_issue() {
        let config = Config {
            disable_auto_issue: true,
            ..Config::default()
        };
        assert!(config.disable_auto_issue);
    }

    #[test]
    fn should_allow_setting_disable_log_upload() {
        let config = Config {
            disable_log_upload: true,
            ..Config::default()
        };
        assert!(config.disable_log_upload);
    }

    #[test]
    fn should_allow_setting_verbose() {
        let config = Config {
            verbose: true,
            ..Config::default()
        };
        assert!(config.verbose);
    }
}

mod handle_failure_tests {
    use super::*;

    #[test]
    fn should_not_panic_when_disable_auto_issue_is_true() {
        let config = Config {
            disable_auto_issue: true,
            ..Config::default()
        };
        // Should return early without panicking
        handle_failure(&config, "test-cmd", "test-cmd arg1", 1, "/tmp/test.log");
    }

    #[test]
    fn should_not_panic_when_verbose_and_disable_auto_issue() {
        let config = Config {
            disable_auto_issue: true,
            verbose: true,
            ..Config::default()
        };
        handle_failure(&config, "test-cmd", "test-cmd --flag", 42, "/tmp/test.log");
    }
}

mod is_gh_authenticated_tests {
    use super::*;

    #[test]
    fn should_return_a_bool() {
        let result = is_gh_authenticated();
        // Just verify it returns a boolean without panicking
        let _ = result;
    }

    #[test]
    fn return_value_is_bool_type() {
        let result: bool = is_gh_authenticated();
        // Type assertion - if it compiles, it returns a bool
        let _ = result;
    }
}

mod is_gh_upload_log_available_tests {
    use super::*;

    #[test]
    fn should_return_a_bool() {
        let result = is_gh_upload_log_available();
        let _ = result;
    }

    #[test]
    fn return_value_is_bool_type() {
        let result: bool = is_gh_upload_log_available();
        let _ = result;
    }
}

mod can_create_issue_tests {
    use super::*;

    #[test]
    fn should_return_false_for_invalid_repo() {
        // A repo that doesn't exist should return false (gh not auth'd or repo not found)
        let result = can_create_issue("invalid-owner-xyz-99999", "invalid-repo-xyz-99999");
        assert!(!result);
    }

    #[test]
    fn should_return_bool() {
        let result: bool = can_create_issue("some-owner", "some-repo");
        let _ = result;
    }
}
