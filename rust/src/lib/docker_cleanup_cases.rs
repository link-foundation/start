use super::*;
use crate::docker_post_mortem::POST_MORTEM_HEADER;

#[test]
fn default_policy_keeps_abnormal_containers() {
    let options = IsolationOptions::default();
    let policy = get_docker_container_cleanup_policy(&options);
    assert_eq!(policy, DockerContainerCleanupPolicy::Default);
    assert!(should_cleanup_docker_container(policy, 0, false));
    assert!(!should_cleanup_docker_container(policy, 7, false));
    assert!(!should_cleanup_docker_container(policy, 0, true));
}

#[test]
fn keep_on_fail_policy_keeps_oom_killed_containers() {
    let options = IsolationOptions {
        keep_container_on_fail: true,
        ..IsolationOptions::default()
    };
    let policy = get_docker_container_cleanup_policy(&options);
    assert_eq!(policy, DockerContainerCleanupPolicy::KeepOnFail);
    assert!(should_cleanup_docker_container(policy, 0, false));
    assert!(!should_cleanup_docker_container(policy, 0, true));
}

#[test]
fn explicit_always_policy_cleans_abnormal_containers() {
    let options = IsolationOptions {
        always_cleanup_container: true,
        ..IsolationOptions::default()
    };
    let policy = get_docker_container_cleanup_policy(&options);
    assert_eq!(policy, DockerContainerCleanupPolicy::Always);
    assert!(should_cleanup_docker_container(policy, 7, false));
    assert!(should_cleanup_docker_container(policy, 0, true));
}

#[test]
fn detached_watcher_inspects_oom_killed_before_default_cleanup() {
    let log_path = PathBuf::from("/tmp/issue144.log");
    let script = build_detached_docker_completion_script(
        "issue144-container",
        DockerContainerCleanupPolicy::Default,
        Some(&log_path),
        None,
    );
    assert!(script.contains(".State.ExitCode"));
    assert!(script.contains(".State.OOMKilled"));
    assert!(script.contains("__start_command_oom"));
    assert!(script.contains("Container kept for investigation"));
    assert!(script.contains("docker rm -f"));
    assert!(script.contains("issue144-container"));
}

/// Evaluate the reason snippet the way the watcher does, in a real shell.
#[cfg(unix)]
fn evaluate_reason(exit_code: &str, oom_killed: &str) -> String {
    let output = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "__start_command_exit={}; __start_command_oom={}; {}; printf '%s' \"$__start_command_reason\"",
                exit_code,
                oom_killed,
                build_docker_kept_reason_snippet()
            ))
            .output()
            .expect("sh");
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
#[cfg(unix)]
fn kept_footer_does_not_assert_a_bare_oom_false_for_self_aborts() {
    // The footer is printed a few lines below the runtime's own
    // `FATAL ERROR: Reached heap limit ...`; it must not contradict it.
    for exit_code in SELF_ABORT_EXIT_CODES {
        let reason = evaluate_reason(&exit_code.to_string(), "false");
        assert!(reason.contains(&format!("exitCode={} oomKilled=false", exit_code)));
        assert!(reason.contains("invisible to this flag"));
    }
}

#[test]
#[cfg(unix)]
fn kept_footer_stays_plain_for_other_exits_and_real_oom_kills() {
    assert_eq!(evaluate_reason("1", "false"), "exitCode=1 oomKilled=false");
    assert_eq!(
        evaluate_reason("137", "true"),
        "exitCode=137 oomKilled=true"
    );
}

#[test]
fn attached_kept_reason_names_a_child_oom_kill_not_the_command() {
    assert!(attached_docker_kept_reason(1, true).contains("a process in it was OOM-killed"));
    assert!(attached_docker_kept_reason(0, true).contains("a process in it was OOM-killed"));
    assert!(attached_docker_kept_reason(137, true).contains("reports it was OOM-killed."));
    assert!(attached_docker_kept_reason(1, false).contains("the command failed"));
}

#[test]
fn detached_watcher_computes_the_kept_reason() {
    let log_path = PathBuf::from("/tmp/issue165.log");
    let script = build_detached_docker_completion_script(
        "issue165-container",
        DockerContainerCleanupPolicy::Default,
        Some(&log_path),
        None,
    );
    assert!(script.contains("__start_command_reason="));
    assert!(script.contains("Reason: %s"));
}

/// Issue #170.1: the watcher must hand the terminal state to the finalizer,
/// so a detached record stops being `executing` forever.
#[test]
fn detached_watcher_invokes_the_finalizer_with_the_inspected_facts() {
    let log_path = PathBuf::from("/tmp/issue170.log");
    let script = build_detached_docker_completion_script(
        "issue170-container",
        DockerContainerCleanupPolicy::Default,
        Some(&log_path),
        Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    );
    assert!(script.contains(crate::detached_finalize::INTERNAL_FINALIZE_FLAG));
    assert!(script.contains("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    assert!(script.contains("$__start_command_exit"));
    assert!(script.contains("$__start_command_finished"));
    // Bookkeeping runs last: a record only becomes terminal once the log is
    // complete, and a failed finalization can never abort the cleanup.
    let finalize_at = script
        .find(crate::detached_finalize::INTERNAL_FINALIZE_FLAG)
        .unwrap();
    let footer_at = script.find("Exit Code: %s").unwrap();
    assert!(finalize_at > footer_at);
}

/// Without an execution id (an un-tracked run) nothing is finalized.
#[test]
fn detached_watcher_stays_backward_compatible_without_an_execution_id() {
    let log_path = PathBuf::from("/tmp/issue170.log");
    let script = build_detached_docker_completion_script(
        "issue170-container",
        DockerContainerCleanupPolicy::Default,
        Some(&log_path),
        None,
    );
    assert!(!script.contains(crate::detached_finalize::INTERNAL_FINALIZE_FLAG));
}

/// Issue #171.1/.2/.3: every cleanup path states the post-mortem facts.
#[test]
fn detached_watcher_writes_the_post_mortem_on_both_paths() {
    let log_path = PathBuf::from("/tmp/issue171.log");
    let script = build_detached_docker_completion_script(
        "issue171-container",
        DockerContainerCleanupPolicy::KeepOnFail,
        Some(&log_path),
        None,
    );
    assert!(script.contains("{{.State.StartedAt}}"));
    assert!(script.contains("{{.State.FinishedAt}}"));
    assert!(script.contains("{{.State.Error}}"));
    assert!(script.contains("=== Container post-mortem ==="));
    assert!(script.contains("Container removed:"));
    assert!(script.contains("Container kept for investigation"));
}

/// A container that is always kept used to produce no completion output at
/// all; it must still get its post-mortem (issue #171.2).
#[test]
fn always_kept_containers_still_get_a_post_mortem() {
    let log_path = PathBuf::from("/tmp/issue171.log");
    let script = build_detached_docker_completion_script(
        "issue171-container",
        DockerContainerCleanupPolicy::Keep,
        Some(&log_path),
        None,
    );
    assert!(script.contains("=== Container post-mortem ==="));
    // The only `docker rm -f` left is the copy-paste hint in the kept message.
    assert!(!script.contains("docker rm -f 'issue171-container' >>"));
}

/// The removal path is the one issue #171.3 is about: at least one line.
#[test]
fn always_removed_containers_get_the_removal_note() {
    let log_path = PathBuf::from("/tmp/issue171.log");
    let script = build_detached_docker_completion_script(
        "issue171-container",
        DockerContainerCleanupPolicy::Always,
        Some(&log_path),
        None,
    );
    assert!(script.contains("Container removed:"));
    assert!(script.contains("docker rm -f 'issue171-container' >>"));
}

#[test]
fn attached_runs_read_every_documented_fact_in_one_inspect() {
    let facts = parse_docker_container_state(
        "demo",
        "137 false 2026-09-15T22:21:40.942007645Z 2026-09-15T22:21:46.740817278Z",
        Some(""),
    );

    assert_eq!(facts.container_name, "demo");
    assert_eq!(facts.exit_code, Some(137));
    assert_eq!(facts.oom_killed, Some(false));
    assert_eq!(
        facts.started_at.as_deref(),
        Some("2026-09-15T22:21:40.942007645Z")
    );
    assert_eq!(
        facts.finished_at.as_deref(),
        Some("2026-09-15T22:21:46.740817278Z")
    );
    assert_eq!(facts.error, None);
}

#[test]
fn attached_runs_reject_the_zero_time_of_a_container_that_never_started() {
    let facts = parse_docker_container_state(
        "demo",
        "125 false 0001-01-01T00:00:00Z 0001-01-01T00:00:00Z",
        Some("no such file or directory"),
    );

    assert_eq!(facts.started_at, None);
    assert_eq!(facts.finished_at, None);
    assert_eq!(facts.error.as_deref(), Some("no such file or directory"));
}

#[test]
fn attached_runs_survive_an_inspect_that_answered_nothing_useful() {
    let facts = parse_docker_container_state("demo", "", None);

    assert_eq!(facts.exit_code, None);
    assert_eq!(facts.oom_killed, None);
    assert_eq!(facts.started_at, None);
    assert_eq!(facts.error, None);
}

#[test]
fn attached_kept_containers_get_the_post_mortem_block_in_their_log() {
    let dir = std::env::temp_dir().join(format!("start-attached-kept-171-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log_path = dir.join("run.log");
    std::fs::write(&log_path, "output\n").unwrap();

    let facts = ContainerPostMortem {
        container_name: "demo".to_string(),
        exit_code: Some(137),
        oom_killed: Some(false),
        started_at: Some("2026-09-15T22:21:40.942007645Z".to_string()),
        finished_at: Some("2026-09-15T22:21:46.740817278Z".to_string()),
        error: None,
    };
    let message = record_attached_docker_post_mortem(Some(&facts), Some(&log_path), false);

    let log = std::fs::read_to_string(&log_path).unwrap();
    assert!(log.contains(POST_MORTEM_HEADER));
    assert!(log.contains("Exit Code:  137 (SIGKILL - 128+9)"));
    assert!(log.contains("Lifetime:   5.798s"));
    assert!(message.contains(POST_MORTEM_HEADER));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn attached_removed_containers_get_the_one_line_note() {
    let dir =
        std::env::temp_dir().join(format!("start-attached-removed-171-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log_path = dir.join("run.log");
    std::fs::write(&log_path, "output\n").unwrap();

    let facts = ContainerPostMortem {
        container_name: "demo".to_string(),
        exit_code: Some(0),
        oom_killed: Some(false),
        started_at: Some("2026-09-15T22:21:40.942007645Z".to_string()),
        finished_at: Some("2026-09-15T22:21:46.740817278Z".to_string()),
        error: None,
    };
    let message = record_attached_docker_post_mortem(Some(&facts), Some(&log_path), true);

    assert!(std::fs::read_to_string(&log_path)
        .unwrap()
        .contains("Container removed: demo (exit 0, lifetime 5.798s, oomKilled=false)"));
    assert_eq!(
        message,
        "\nContainer removed: demo (exit 0, lifetime 5.798s, oomKilled=false)"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn attached_runs_stay_silent_when_docker_could_not_be_inspected() {
    let dir =
        std::env::temp_dir().join(format!("start-attached-silent-171-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let log_path = dir.join("run.log");
    std::fs::write(&log_path, "output\n").unwrap();

    assert_eq!(
        record_attached_docker_post_mortem(None, Some(&log_path), false),
        ""
    );
    assert_eq!(std::fs::read_to_string(&log_path).unwrap(), "output\n");
    let _ = std::fs::remove_dir_all(&dir);
}
