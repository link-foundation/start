//! Regression tests for issue #263: `$ --pause <id>` / `$ --unpause <id>`
//! freeze and thaw a detached Docker execution with `docker pause` (cgroup
//! freezer). CPU is released, memory and the process stay, and the same
//! process continues on unpause. Paused executions are reported, never
//! resumed, attached to, cleaned up or recovered, and a stale recorded pause
//! is reconciled against `docker inspect`.

use serde_json::json;
use start_command::execution_attach::InteractiveRunOutput;
use start_command::execution_cleanup::cleanup_execution;
use start_command::execution_pause::{
    attach_pause_state_with_state, pause_execution_with_runner, unpause_execution_with_runner,
    PauseRequest, DOCKER_PAUSE_TIMEOUT,
};
use start_command::execution_recovery::{recover_killed_execution, RecoveryFacts};
use start_command::session_probe::map_docker_status_to_state;
use start_command::{
    attach_execution_with_runners, control_execution_with_runner, parse_args, probe_session,
    resume_all_executions_with, resume_execution_with, AttachPlan, ControlAction,
    DockerWatcherOptions, ExecutionRecord, ExecutionStatus, InteractiveRunner, IsolationOptions,
    IsolationResult, ResumeHooks, SessionState,
};
use std::cell::Cell;

#[path = "support/issue_263.rs"]
mod support;
use support::*;

mod parsing {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn parses_the_identifiers_reason_and_actor_in_both_forms() {
        let parsed = parse_args(&args(&[
            "--pause",
            NAME,
            "--pause-reason",
            "rate limit",
            "--paused-by=hive-mind",
        ]))
        .unwrap();
        let options = parsed.wrapper_options;
        assert_eq!(options.pause.as_deref(), Some(NAME));
        assert_eq!(options.pause_reason.as_deref(), Some("rate limit"));
        assert_eq!(options.paused_by.as_deref(), Some("hive-mind"));
        let unpause = parse_args(&args(&[&format!("--unpause={UUID}")])).unwrap();
        assert_eq!(unpause.wrapper_options.unpause.as_deref(), Some(UUID));
        let json = parse_args(&args(&["--unpause", NAME, "--output-format", "json"])).unwrap();
        assert_eq!(json.wrapper_options.output_format.as_deref(), Some("json"));
    }

    #[test]
    fn rejects_combinations_and_stray_detail_options() {
        let combined = parse_args(&args(&["--pause", NAME, "--stop", NAME])).unwrap_err();
        assert!(combined.contains("Cannot combine"), "{combined}");
        assert!(combined.contains("--pause, --unpause"), "{combined}");
        assert!(parse_args(&args(&["--pause", NAME, "--unpause", NAME]))
            .unwrap_err()
            .contains("Cannot combine"));
        assert_eq!(
            parse_args(&args(&["--unpause", NAME, "--pause-reason", "x"])).unwrap_err(),
            "--pause-reason and --paused-by options are only valid with --pause"
        );
        assert_eq!(
            parse_args(&args(&["--pause", NAME, "--pause-reason"])).unwrap_err(),
            "Option --pause-reason requires a value"
        );
        assert!(parse_args(&args(&["--pause"])).is_err());
    }
}

#[test]
fn session_probe_reads_a_paused_container_as_paused_and_alive() {
    assert_eq!(
        map_docker_status_to_state(Some("paused")),
        SessionState::Paused
    );
    let probe = probe_session(&make_record(&[]), &FakeDocker::new("paused"));
    assert_eq!(probe.state, SessionState::Paused);
    assert!(probe.alive);
}

mod pause {
    use super::*;

    #[test]
    fn pauses_with_an_argv_array_and_a_timeout_keeping_the_same_record() {
        let (_dir, store) = make_store();
        let original = make_record(&[]);
        store.save(&original).unwrap();
        let docker = FakeDocker::new("running");
        let result = pause_execution_with_runner(
            Some(&store),
            NAME,
            PauseRequest {
                reason: Some("rate limit"),
                by: Some("hive-mind"),
                output_format: Some("json"),
            },
            &docker,
        );
        assert!(result.success, "{:?}", result.error);
        let report = json_output(result.output);
        for (key, value) in [
            ("action", json!("pause")),
            ("uuid", json!(UUID)),
            ("status", json!("paused")),
            ("method", json!("DOCKER_PAUSE")),
            ("dockerState", json!("paused")),
            ("paused", json!(true)),
            ("pauseCount", json!(1)),
            ("pausedBy", json!("hive-mind")),
            ("pauseReason", json!("rate limit")),
            (
                "resources",
                json!({"cpu": "released", "memory": "retained", "disk": "retained"}),
            ),
        ] {
            assert_eq!(report[key], value, "{key}");
        }
        let message = report["message"].as_str().unwrap();
        assert_mentions(
            message,
            "memory stays allocated",
            "\"memory stays allocated\"",
        );
        assert_mentions(
            message,
            &format!("--unpause {UUID}"),
            "the --unpause <uuid> hint",
        );
        assert_eq!(report["processIds"]["containerPid"], json!(4242));
        assert_eq!(docker.ran("pause"), vec![vec!["pause", NAME]]);
        // Every docker call is bounded, the process-ID lookup included.
        for (args, timeout) in docker.calls.borrow().iter() {
            assert_eq!(*timeout, Some(DOCKER_PAUSE_TIMEOUT), "{args:?}");
        }

        let all = store.get_all();
        assert_eq!(all.len(), 1);
        let saved = &all[0];
        assert_eq!(saved.uuid, UUID);
        assert_eq!(saved.status, ExecutionStatus::Executing);
        assert_eq!(saved.log_path, original.log_path);
        let options = &saved.options;
        assert_eq!(options["paused"], json!(true));
        assert_eq!(options["pauseCount"], json!(1));
        assert_eq!(options["pausedBy"], json!("hive-mind"));
        assert_eq!(options["pauseReason"], json!("rate limit"));
        assert_eq!(options["image"], json!("alpine:3.23"));
        let paused_at = options["pausedAt"].as_str().unwrap();
        assert!(chrono::DateTime::parse_from_rfc3339(paused_at).is_ok());
        assert!(!options.contains_key("recoveryAttempts"));
    }

    #[test]
    fn is_idempotent_on_an_already_paused_container() {
        let (_dir, store) = make_store();
        store.save(&make_record(&[])).unwrap();
        let docker = FakeDocker::new("running");
        pause_execution_with_runner(Some(&store), NAME, request(None), &docker);
        let first = saved_options(&store)["pausedAt"].clone();
        let again = pause_execution_with_runner(Some(&store), NAME, request(Some("json")), &docker);
        assert!(again.success);
        let report = json_output(again.output);
        assert_eq!(report["status"], json!("already-paused"));
        assert_eq!(report["method"], json!("NONE"));
        assert_eq!(report["paused"], json!(true));
        assert_eq!(docker.ran("pause").len(), 1);
        assert_eq!(saved_options(&store)["pauseCount"], json!(1));
        assert_eq!(saved_options(&store)["pausedAt"], first);
    }

    #[test]
    fn adopts_a_pause_made_outside_start_command() {
        let (_dir, store) = make_store();
        store.save(&make_record(&[])).unwrap();
        let result = pause_execution_with_runner(
            Some(&store),
            NAME,
            request(None),
            &FakeDocker::new("paused"),
        );
        assert!(result.success);
        assert!(result.output.unwrap().contains("already-paused"));
        assert_eq!(saved_options(&store)["paused"], json!(true));
    }

    #[test]
    fn fails_on_an_exited_container_and_clears_a_stale_pause() {
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[
                ("paused", json!(true)),
                ("pausedAt", json!("x")),
                ("pauseCount", json!(1)),
            ]))
            .unwrap();
        let docker = FakeDocker::new("exited");
        let result = pause_execution_with_runner(Some(&store), NAME, request(None), &docker);
        assert!(!result.success);
        let error = result.error.unwrap();
        assert_mentions(
            &error,
            "is exited, not running",
            "\"is exited, not running\"",
        );
        assert_mentions(
            &error,
            &format!("--status {UUID}"),
            "the --status <uuid> hint",
        );
        assert_mentions(
            &error,
            &format!("--resume {UUID}"),
            "the --resume <uuid> hint",
        );
        assert!(docker.ran("pause").is_empty());
        let options = saved_options(&store);
        assert_eq!(options["paused"], json!(false));
        assert_eq!(options["pauseEndedBy"], json!("reconcile"));
    }

    #[test]
    fn fails_on_a_removed_container_and_records_the_removal() {
        let (_dir, store) = make_store();
        store
            .save(&record_with(
                &[("paused", json!(true)), ("pausedAt", json!("x"))],
                ExecutionStatus::Executed,
                Some(137),
            ))
            .unwrap();
        let result = pause_execution_with_runner(
            Some(&store),
            NAME,
            request(None),
            &FakeDocker::new("removed"),
        );
        assert!(!result.success);
        let error = result.error.unwrap();
        assert_mentions(
            &error,
            "no longer exists (removed)",
            "\"no longer exists (removed)\"",
        );
        assert_mentions(
            &error,
            &format!("--resume {UUID}"),
            "the --resume <uuid> hint",
        );
        let saved = store.get(UUID).unwrap();
        assert_eq!(saved.container_state.as_deref(), Some("removed"));
        assert_eq!(saved.options["paused"], json!(false));
    }

    #[test]
    fn refuses_screen_tmux_and_attached_docker_executions() {
        for isolated in ["screen", "tmux"] {
            let (_dir, store) = make_store();
            store
                .save(&make_record(&[("isolated", json!(isolated))]))
                .unwrap();
            let docker = FakeDocker::new("running");
            let result = pause_execution_with_runner(Some(&store), NAME, request(None), &docker);
            assert!(!result.success);
            let error = result.error.unwrap();
            assert_mentions(
                &error,
                &format!("--pause only supports Docker isolation: {NAME} uses {isolated}"),
                "the Docker-only refusal",
            );
            assert!(docker.calls.borrow().is_empty());
        }
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[("isolationMode", json!("attached"))]))
            .unwrap();
        let docker = FakeDocker::new("running");
        assert_eq!(
            unpause_execution_with_runner(Some(&store), NAME, None, &docker)
                .error
                .as_deref(),
            Some("Only detached Docker executions can be unpaused.")
        );
        let missing = pause_execution_with_runner(Some(&store), "nope", request(None), &docker);
        assert!(missing.error.unwrap().contains("No execution found"));
        let disabled = pause_execution_with_runner(None, NAME, request(None), &docker);
        assert_eq!(
            disabled.error.as_deref(),
            Some("Execution tracking is disabled.")
        );
    }

    #[test]
    fn reports_a_docker_failure_without_changing_the_record() {
        let (_dir, store) = make_store();
        store.save(&make_record(&[])).unwrap();
        let docker = FakeDocker {
            fail_pause: true,
            ..FakeDocker::new("running")
        };
        let result = pause_execution_with_runner(Some(&store), NAME, request(None), &docker);
        assert!(!result.success);
        assert!(result.output.is_none());
        assert_eq!(
            result.error.as_deref(),
            Some(format!("Failed to pause docker container \"{NAME}\": boom").as_str())
        );
        assert!(!saved_options(&store).contains_key("paused"));
    }
}

mod unpause {
    use super::*;

    #[test]
    fn unpauses_a_paused_container_and_keeps_the_same_process() {
        let (_dir, store) = make_store();
        store.save(&make_record(&[])).unwrap();
        let docker = FakeDocker::new("running");
        let paused = pause_execution_with_runner(
            Some(&store),
            NAME,
            PauseRequest {
                by: Some("me"),
                output_format: Some("json"),
                ..Default::default()
            },
            &docker,
        );
        let pid_while_paused = json_output(paused.output)["processIds"]["containerPid"].clone();
        let result = unpause_execution_with_runner(Some(&store), UUID, Some("json"), &docker);
        assert!(result.success, "{:?}", result.error);
        let report = json_output(result.output);
        assert_eq!(report["action"], json!("unpause"));
        assert_eq!(report["status"], json!("unpaused"));
        assert_eq!(report["method"], json!("DOCKER_UNPAUSE"));
        assert_eq!(report["dockerState"], json!("running"));
        assert_eq!(report["paused"], json!(false));
        // The same process continues: the container PID did not change.
        assert_eq!(report["processIds"]["containerPid"], pid_while_paused);
        assert_eq!(docker.ran("unpause"), vec![vec!["unpause", NAME]]);
        let options = saved_options(&store);
        assert_eq!(options["paused"], json!(false));
        assert_eq!(options["pauseCount"], json!(1));
        assert_eq!(options["pauseEndedBy"], json!("unpause"));
        assert!(!options.contains_key("pausedAt"));
        assert!(!options.contains_key("pausedBy"));
        assert_eq!(store.get_all().len(), 1);
    }

    #[test]
    fn is_idempotent_on_a_running_container_and_reconciles_the_record() {
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[
                ("paused", json!(true)),
                ("pausedAt", json!("x")),
                ("pauseCount", json!(2)),
            ]))
            .unwrap();
        let docker = FakeDocker::new("running");
        let result = unpause_execution_with_runner(Some(&store), NAME, None, &docker);
        assert!(result.success);
        assert!(result.output.unwrap().contains("status not-paused"));
        assert!(docker.ran("unpause").is_empty());
        let options = saved_options(&store);
        assert_eq!(options["paused"], json!(false));
        assert_eq!(options["pauseCount"], json!(2));
        assert_eq!(options["pauseEndedBy"], json!("reconcile"));
    }

    #[test]
    fn fails_on_exited_and_removed_containers_with_a_recovery_path() {
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[("paused", json!(true))]))
            .unwrap();
        let exited =
            unpause_execution_with_runner(Some(&store), NAME, None, &FakeDocker::new("exited"));
        assert!(!exited.success);
        let error = exited.error.unwrap();
        assert_mentions(&error, "is exited, not paused", "\"is exited, not paused\"");
        assert_mentions(
            &error,
            &format!("--resume {UUID}"),
            "the --resume <uuid> hint",
        );
        let removed =
            unpause_execution_with_runner(Some(&store), NAME, None, &FakeDocker::new("removed"));
        assert!(!removed.success);
        let error = removed.error.unwrap();
        assert_mentions(
            &error,
            "no longer exists (removed)",
            "\"no longer exists (removed)\"",
        );
        assert_mentions(
            &error,
            &format!("--status {UUID}"),
            "the --status <uuid> hint",
        );
    }

    #[test]
    fn renders_text_and_links_notation_reports() {
        let (_dir, store) = make_store();
        store.save(&make_record(&[])).unwrap();
        let docker = FakeDocker::new("running");
        let text = pause_execution_with_runner(Some(&store), NAME, request(Some("text")), &docker)
            .output
            .unwrap();
        assert!(text.contains("Docker State:  paused"), "{text}");
        assert!(
            text.contains("CPU released, memory retained, disk retained"),
            "{text}"
        );
        assert!(text.contains("Container PID: 4242"), "{text}");
        let lino = unpause_execution_with_runner(Some(&store), NAME, None, &docker)
            .output
            .unwrap();
        assert_eq!(lino.lines().next(), Some("executionControl"));
        assert!(lino.contains("  status unpaused"), "{lino}");
    }
}

mod paused_guards {
    use super::*;

    struct CountingInteractive(Cell<usize>);

    impl InteractiveRunner for CountingInteractive {
        fn run(&self, _plan: &AttachPlan) -> InteractiveRunOutput {
            self.0.set(self.0.get() + 1);
            InteractiveRunOutput {
                success: true,
                status: Some(0),
                error: None,
            }
        }
    }

    struct NoLaunch;

    impl ResumeHooks for NoLaunch {
        fn start_watcher(&self, _name: &str, _record: &ExecutionRecord) {
            panic!("must not watch");
        }
        fn relaunch(&self, _: &str, _: &str, _: &IsolationOptions) -> IsolationResult {
            panic!("must not launch");
        }
        fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
            record.clone()
        }
    }

    #[test]
    fn attach_is_refused_without_starting_an_interactive_session() {
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[("paused", json!(true))]))
            .unwrap();
        let interactive = CountingInteractive(Cell::new(0));
        let result = attach_execution_with_runners(
            Some(&store),
            NAME,
            false,
            &FakeDocker::new("paused"),
            &interactive,
        );
        assert!(!result.success);
        let error = result.error.unwrap();
        assert_mentions(&error, "is paused", "\"is paused\"");
        assert_mentions(
            &error,
            &format!("--unpause {UUID}"),
            "the --unpause <uuid> hint",
        );
        assert_eq!(interactive.0.get(), 0);
    }

    #[test]
    fn resume_is_refused_and_takes_no_snapshot() {
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[("paused", json!(true))]))
            .unwrap();
        let docker = FakeDocker::new("paused");
        let result = resume_execution_with(Some(&store), NAME, None, None, &docker, &NoLaunch);
        assert!(!result.success);
        let error = result.error.unwrap();
        assert_mentions(
            &error,
            &format!("--unpause {UUID}"),
            "the --unpause <uuid> hint",
        );
        assert!(docker.ran("commit").is_empty());
        assert!(docker.ran("start").is_empty());
        assert_eq!(docker.state(), "paused");
        assert_eq!(store.get_all().len(), 1);
    }

    #[test]
    fn resume_all_skips_a_paused_execution_with_a_reason() {
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[("paused", json!(true))]))
            .unwrap();
        let result = resume_all_executions_with(
            Some(&store),
            Some("json"),
            &FakeDocker::new("paused"),
            &NoLaunch,
        );
        assert!(result.success, "{:?}", result.error);
        let summary = json_output(result.output);
        let entry = &summary["executions"][0];
        assert_eq!(entry["uuid"], json!(UUID));
        assert_eq!(entry["state"], json!("paused"));
        assert_eq!(entry["action"], json!("paused"));
        let message = entry["message"].as_str().unwrap();
        assert_mentions(
            message,
            "Skipped paused container",
            "\"Skipped paused container\"",
        );
        assert_mentions(
            message,
            &format!("--unpause {UUID}"),
            "the --unpause <uuid> hint",
        );
    }

    #[test]
    fn cleanup_retains_a_paused_container() {
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[("paused", json!(true))]))
            .unwrap();
        let docker = FakeDocker::new("paused");
        let result = cleanup_execution(Some(&store), NAME, false, &docker);
        assert!(!result.success);
        assert_eq!(
            result.output.as_deref(),
            Some(format!("Retained container {NAME} (paused)").as_str())
        );
        assert!(docker.ran("rm").is_empty());
        assert!(docker.ran("rmi").is_empty());
        assert_eq!(docker.state(), "paused");
    }

    fn killed() -> RecoveryFacts {
        RecoveryFacts {
            exit_code: "137".into(),
            oom_killed: "false".into(),
            ..Default::default()
        }
    }

    fn no_watcher(_: &str, _: &ExecutionRecord, _: &DockerWatcherOptions) {
        panic!("must not start a watcher");
    }

    #[test]
    fn stop_and_terminate_count_as_intentional_and_clear_the_pause() {
        for action in [ControlAction::Stop, ControlAction::Terminate] {
            let (_dir, store) = make_store();
            store
                .save(&make_record(&[("onKillResume", json!(3))]))
                .unwrap();
            let docker = FakeDocker::new("running");
            pause_execution_with_runner(Some(&store), NAME, request(None), &docker);
            let result = control_execution_with_runner(Some(&store), NAME, action, &docker);
            assert!(result.success, "{:?}", result.error);
            let options = saved_options(&store);
            assert_eq!(options["paused"], json!(false));
            assert_eq!(options["pauseEndedBy"], json!(action.as_str()));
            let requested = options["stopRequestedAt"].as_str().unwrap();
            assert!(chrono::DateTime::parse_from_rfc3339(requested).is_ok());

            let recovery = recover_killed_execution(&store, UUID, &killed(), &docker, &no_watcher);
            assert!(!recovery.recovered);
            assert_eq!(recovery.reason, "stop-requested");
            assert_eq!(store.get_all().len(), 1);
        }
    }

    #[test]
    fn stop_intent_is_recorded_for_a_paused_execution_without_on_kill_resume() {
        let (_dir, store) = make_store();
        store.save(&make_record(&[])).unwrap();
        let docker = FakeDocker::new("running");
        pause_execution_with_runner(Some(&store), NAME, request(None), &docker);
        control_execution_with_runner(Some(&store), NAME, ControlAction::Stop, &docker);
        assert!(saved_options(&store).contains_key("stopRequestedAt"));
    }

    #[test]
    fn a_paused_execution_killed_from_outside_is_never_auto_recovered() {
        let (_dir, store) = make_store();
        store
            .save(&make_record(&[
                ("onKillResume", json!(3)),
                ("paused", json!(true)),
            ]))
            .unwrap();
        let recovery = recover_killed_execution(
            &store,
            UUID,
            &killed(),
            &FakeDocker::new("exited"),
            &no_watcher,
        );
        assert!(!recovery.recovered);
        assert_eq!(recovery.reason, "paused");
        assert_eq!(store.get_all().len(), 1);
    }
}

#[test]
fn keeps_the_recorded_pause_when_docker_cannot_be_asked() {
    let record = make_record(&[("paused", json!(true)), ("pausedAt", json!("p"))]);
    let reported = attach_pause_state_with_state(record, Some("unknown".to_string()));
    assert_eq!(reported.docker_state.as_deref(), Some("unknown"));
    assert_eq!(reported.paused, Some(true));
    assert_eq!(reported.paused_at.as_deref(), Some("p"));
    let screen = attach_pause_state_with_state(make_record(&[("isolated", json!("screen"))]), None);
    assert!(screen.docker_state.is_none());
    assert!(screen.paused.is_none());
}
