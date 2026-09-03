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

/// Mirrors the JS `createIssue` regression tests for issue #168: the title and
/// body must reach `gh` verbatim, with real newlines and without shell escaping.
#[cfg(unix)]
mod create_issue_tests {
    use start_command::failure_handler::{create_issue, RepoInfo};
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use tempfile::TempDir;

    const FAILING_COMMAND: &str = "echo \"quoted\" $(id) `hostname`";
    const HELPER_TEST: &str = "create_issue_tests::helper_process_calls_create_issue";
    const URL_PREFIX: &str = "created-issue-url:";

    /// Not a test on its own: re-executed by `create_issue_with_fake_gh` in a
    /// child process, because `PATH` has to be replaced only for that child.
    /// Mutating it in-process would also redirect the `gh` calls of the tests
    /// running next to it in the same binary.
    #[test]
    #[ignore = "helper process, driven by create_issue_with_fake_gh"]
    fn helper_process_calls_create_issue() {
        let repo_info = RepoInfo {
            owner: "owner".to_string(),
            repo: "repo".to_string(),
            url: "https://github.com/owner/repo".to_string(),
        };
        let url = create_issue(&repo_info, FAILING_COMMAND, 1, None).unwrap_or_default();
        println!("{}{}", URL_PREFIX, url);
    }

    /// Run `create_issue` with a fake `gh` first on the child's PATH that
    /// records its argv, NUL-separated, and return the URL and that argv.
    fn create_issue_with_fake_gh() -> (Option<String>, Vec<String>) {
        let dir = TempDir::new().unwrap();
        let argv_file = dir.path().join("argv");
        let gh_path = dir.path().join("gh");
        std::fs::write(
            &gh_path,
            format!(
                "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"{}\"\necho https://github.com/owner/repo/issues/1\n",
                argv_file.display()
            ),
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&gh_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&gh_path, permissions).unwrap();

        let mut paths = vec![dir.path().to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }

        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", HELPER_TEST, "--ignored", "--nocapture"])
            .env("PATH", std::env::join_paths(paths).unwrap())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "helper process failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let url = stdout
            .lines()
            .find_map(|line| line.strip_prefix(URL_PREFIX))
            .filter(|url| !url.is_empty())
            .map(str::to_string);

        let recorded = std::fs::read_to_string(&argv_file).unwrap();
        // `printf '%s\0'` writes a trailing NUL, so the final split part is empty.
        let mut argv = recorded.split('\0').map(str::to_string).collect::<Vec<_>>();
        argv.pop();
        (url, argv)
    }

    #[test]
    fn passes_the_title_and_body_as_separate_arguments() {
        let (url, argv) = create_issue_with_fake_gh();
        assert_eq!(
            url.as_deref(),
            Some("https://github.com/owner/repo/issues/1")
        );
        assert_eq!(argv[0..4], ["issue", "create", "--repo", "owner/repo"]);
        assert_eq!(argv[4], "--title");
        assert_eq!(argv[6], "--body");
        assert_eq!(argv.len(), 8);
    }

    #[test]
    fn keeps_the_failing_command_verbatim_and_writes_real_newlines() {
        let (_, argv) = create_issue_with_fake_gh();
        let title = &argv[5];
        let body = &argv[7];
        assert!(
            title.contains(FAILING_COMMAND),
            "title must quote the command verbatim, got: {}",
            title
        );
        assert!(
            body.contains(FAILING_COMMAND),
            "body must quote the command verbatim"
        );
        assert!(!title.contains("\\\""), "title must not escape quotes");
        assert!(!body.contains("\\\""), "body must not escape quotes");
        assert!(body.contains('\n'), "body must contain real newlines");
        assert!(
            !body.contains("\\n"),
            "body must not contain literal backslash-n sequences"
        );
    }
}
