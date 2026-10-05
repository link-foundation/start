//! Regression tests for issue #181:
//!
//! `--on-kill-resume <N>` restarted a killed detached docker execution right
//! after its watcher saw it end. One host-wide OOM event that kills several
//! executions made every watcher resume its container in the same second; all
//! of them rebuilt their working sets at once and triggered the next OOM event.
//!
//! `--on-kill-resume-delay <min[-max]>` waits a uniformly random number of
//! seconds before each recovery. The chosen delay is printed in the
//! `[Recovery k/N]` line and stored in `recoveryHistory` (`delayMs`), and a
//! `--stop` during the wait cancels the pending recovery.

use serde_json::{json, Value};
use start_command::execution_recovery::{
    format_recovery_separator, recover_killed_execution_with_delay, RecoveryDelayHooks,
    RecoveryFacts, RecoveryOutcome, RecoverySeparator,
};
use start_command::isolation_metadata::{
    recovery_metadata_with_delay, recovery_status_lines_with_delay,
};
use start_command::recovery_delay::{
    parse_on_kill_resume_delay_value, pick_recovery_delay_ms, system_random, system_sleep,
    wait_for_recovery_delay,
};
use start_command::{
    control_execution_with_runner, parse_args, ControlAction, DockerWatcherOptions,
    ExecutionRecord, ExecutionStatus, ExecutionStore, WrapperOptions,
};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::time::Instant;
use tempfile::TempDir;
#[path = "support/issue_176.rs"]
mod support;
use support::*;

fn parse(flags: &[&str]) -> Result<WrapperOptions, String> {
    let mut all = vec!["--isolated", "docker", "--detached"];
    all.extend_from_slice(flags);
    all.extend_from_slice(&["--", "a"]);
    parse_args(&args(&all)).map(|parsed| parsed.wrapper_options)
}

struct Fixture {
    _temp: TempDir,
    store: ExecutionStore,
    record: ExecutionRecord,
    log_path: PathBuf,
}

impl Fixture {
    fn new(extra: Value) -> Self {
        let temp = TempDir::new().unwrap();
        let store = test_store(&temp.path().join("app"));
        let log_path = temp.path().join("run.log");
        std::fs::write(&log_path, "main output\n").unwrap();
        let mut options = json!({ "onKillResume": 3, "onKillResumeDelay": "30-90" });
        for (key, value) in extra.as_object().unwrap() {
            options[key] = value.clone();
        }
        let record = docker_record(ExecutionStatus::Executing, Some(&log_path), options);
        store.save(&record).unwrap();
        Fixture {
            _temp: temp,
            store,
            record,
            log_path,
        }
    }

    fn log(&self) -> String {
        std::fs::read_to_string(&self.log_path).unwrap()
    }

    fn stored(&self) -> ExecutionRecord {
        self.store.get(&self.record.uuid).unwrap()
    }

    fn recover(&self, runner: &FakeRunner, sleep: &dyn Fn(u64)) -> RecoveryOutcome {
        recover_killed_execution_with_delay(
            &self.store,
            &self.record.uuid,
            &killed(),
            runner,
            &|_: &str, _: &ExecutionRecord, _: &DockerWatcherOptions| {},
            &RecoveryDelayHooks {
                random: &|| 0.5,
                sleep,
            },
        )
    }

    fn terminate(&self, runner: &FakeRunner) -> start_command::ExecutionControlResult {
        control_execution_with_runner(
            Some(&self.store),
            &self.record.uuid,
            ControlAction::Terminate,
            runner,
        )
    }
}

fn killed() -> RecoveryFacts {
    RecoveryFacts {
        exit_code: "137".to_string(),
        oom_killed: "true".to_string(),
        started_at: "2026-10-01T10:00:00Z".to_string(),
        finished_at: "2026-10-01T10:05:00Z".to_string(),
        container_error: String::new(),
    }
}

// ---------------------------------------------------------------------------
// --on-kill-resume-delay parsing
// ---------------------------------------------------------------------------

#[test]
fn accepts_a_range_a_fixed_delay_and_zero_with_or_without_equals() {
    let options = parse(&["--on-kill-resume", "3", "--on-kill-resume-delay", "30-90"]).unwrap();
    assert_eq!(options.on_kill_resume, Some(3));
    assert_eq!(options.on_kill_resume_delay.as_deref(), Some("30-90"));
    let fixed = parse(&["--on-kill-resume=3", "--on-kill-resume-delay=45"]).unwrap();
    assert_eq!(fixed.on_kill_resume_delay.as_deref(), Some("45"));
    let zero = parse(&["--on-kill-resume", "1", "--on-kill-resume-delay", "0"]).unwrap();
    assert_eq!(zero.on_kill_resume_delay.as_deref(), Some("0"));
    assert_eq!(
        parse_on_kill_resume_delay_value("1.5-2.5").unwrap(),
        "1.5-2.5"
    );
}

#[test]
fn defaults_to_no_delay() {
    let options = parse(&["--on-kill-resume", "3"]).unwrap();
    assert_eq!(options.on_kill_resume_delay, None);
}

#[test]
fn rejects_malformed_and_reversed_ranges() {
    for value in ["abc", "90-30", "-5", "30-", "1-2-3", ""] {
        let error = parse_on_kill_resume_delay_value(value).unwrap_err();
        assert!(
            error.contains("Invalid --on-kill-resume-delay value"),
            "{}: {}",
            value,
            error
        );
    }
    let error = parse(&["--on-kill-resume", "1", "--on-kill-resume-delay"]).unwrap_err();
    assert!(error.contains("requires a seconds argument"), "{}", error);
}

#[test]
fn requires_on_kill_resume_or_recovery_command() {
    let error = parse(&["--on-kill-resume-delay", "30-90"]).unwrap_err();
    assert!(
        error.contains("--on-kill-resume-delay requires --on-kill-resume or --recovery-command"),
        "{}",
        error
    );
    let options = parse(&["--recovery-command", "b", "--on-kill-resume-delay", "30-90"]).unwrap();
    assert_eq!(options.on_kill_resume_delay.as_deref(), Some("30-90"));
}

#[test]
fn shows_the_delay_in_the_isolation_line_and_stores_it() {
    assert_eq!(
        recovery_status_lines_with_delay(Some(3), None, Some("30-90")),
        vec![
            "[Isolation] On kill: resume up to 3 time(s) after a random 30-90s delay with the original command"
                .to_string()
        ]
    );
    assert!(recovery_metadata_with_delay(Some(3), None, Some("30-90"))
        .contains(&("onKillResumeDelay".to_string(), json!("30-90"))));
    assert!(!recovery_metadata_with_delay(Some(3), None, Some("0"))
        .iter()
        .any(|(key, _)| key == "onKillResumeDelay"));
    assert_eq!(
        recovery_status_lines_with_delay(Some(3), None, Some("0")),
        vec!["[Isolation] On kill: resume up to 3 time(s) with the original command".to_string()]
    );
}

// ---------------------------------------------------------------------------
// Picking and waiting out the delay
// ---------------------------------------------------------------------------

#[test]
fn picks_uniformly_within_the_range() {
    assert_eq!(pick_recovery_delay_ms(Some("30-90"), &|| 0.0), 30000);
    assert_eq!(pick_recovery_delay_ms(Some("30-90"), &|| 0.5), 60000);
    assert_eq!(pick_recovery_delay_ms(Some("30-90"), &|| 0.999999), 90000);
    assert_eq!(pick_recovery_delay_ms(Some("45"), &|| 0.7), 45000);
    assert_eq!(pick_recovery_delay_ms(Some("0"), &system_random), 0);
    assert_eq!(pick_recovery_delay_ms(None, &system_random), 0);
    for _ in 0..100 {
        let ms = pick_recovery_delay_ms(Some("30-90"), &system_random);
        assert!((30000..=90000).contains(&ms), "{}", ms);
    }
}

#[test]
fn waits_in_short_steps_and_stops_as_soon_as_it_is_cancelled() {
    let sleeps = RefCell::new(Vec::new());
    assert!(!wait_for_recovery_delay(
        2500,
        &|ms| sleeps.borrow_mut().push(ms),
        &|| false
    ));
    assert_eq!(sleeps.into_inner(), vec![1000, 1000, 500]);

    let cancelled = RefCell::new(Vec::new());
    assert!(wait_for_recovery_delay(
        60000,
        &|ms| cancelled.borrow_mut().push(ms),
        &|| cancelled.borrow().len() >= 2
    ));
    assert_eq!(cancelled.into_inner(), vec![1000, 1000]);
}

#[test]
fn really_blocks_the_thread_for_the_real_sleep() {
    let start = Instant::now();
    system_sleep(50);
    assert!(start.elapsed().as_millis() >= 45);
}

// ---------------------------------------------------------------------------
// Recovering after the delay
// ---------------------------------------------------------------------------

#[test]
fn prints_the_delay_in_the_recovery_line() {
    assert_eq!(
        format_recovery_separator(&RecoverySeparator {
            attempt: 1,
            max_attempts: 3,
            exit_code: "137",
            oom_killed: "true",
            container_name: "box",
            command: None,
            delay_ms: 42500,
        }),
        "\n[Recovery 1/3] Main process was killed (exit 137, SIGKILL, oomKilled=true); resuming container box after a 42.5s delay, running the original command again\n"
    );
}

#[test]
fn waits_before_docker_start_and_records_delay_ms_in_the_history() {
    let fixture = Fixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config());
    let sleeps = RefCell::new(Vec::new());
    let outcome = fixture.recover(&runner, &|ms| sleeps.borrow_mut().push(ms));
    assert_eq!(
        outcome,
        RecoveryOutcome {
            recovered: true,
            reason: "resumed".to_string(),
            attempt: Some(1),
            delay_ms: Some(60000),
        }
    );
    assert_eq!(sleeps.into_inner().iter().sum::<u64>(), 60000);
    assert!(runner.call("start").is_some());
    assert!(fixture.log().contains(
        "[Recovery 1/3] Main process was killed (exit 137, SIGKILL, oomKilled=true); resuming container box after a 60s delay"
    ));
    let stored = fixture.stored();
    let history = stored.options["recoveryHistory"].as_array().unwrap();
    assert_eq!(history.len(), 1);
    assert!(history[0]
        .as_str()
        .unwrap()
        .starts_with("1: exit 137, oomKilled=true, delayMs=60000, resumed at "));
    assert_eq!(stored.options["lastRecoveryDelayMs"], json!(60000));
}

#[test]
fn keeps_the_old_behaviour_and_history_format_without_a_delay() {
    let fixture = Fixture::new(json!({ "onKillResumeDelay": null }));
    let runner = FakeRunner::new(updated_host_config());
    let sleeps = RefCell::new(Vec::new());
    let outcome = fixture.recover(&runner, &|ms| sleeps.borrow_mut().push(ms));
    assert_eq!(outcome.delay_ms, None);
    assert!(outcome.recovered);
    assert!(sleeps.into_inner().is_empty());
    let stored = fixture.stored();
    assert!(stored.options["recoveryHistory"][0]
        .as_str()
        .unwrap()
        .starts_with("1: exit 137, oomKilled=true, resumed at "));
    assert!(!stored.options.contains_key("lastRecoveryDelayMs"));
}

#[test]
fn a_stop_during_the_wait_cancels_the_pending_recovery() {
    let fixture = Fixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config());
    let stopped = Cell::new(false);
    let sleep = |_: u64| {
        if !stopped.replace(true) {
            // `docker stop` on the already exited container succeeds.
            let stop_runner = FakeRunner::new(updated_host_config());
            let result = control_execution_with_runner(
                Some(&fixture.store),
                &fixture.record.uuid,
                ControlAction::Stop,
                &stop_runner,
            );
            assert!(result.success, "{:?}", result.error);
        }
    };
    let outcome = fixture.recover(&runner, &sleep);
    assert!(!outcome.recovered);
    assert_eq!(outcome.reason, "stop-requested");
    assert_eq!(outcome.attempt, Some(1));
    assert!(runner.call("start").is_none());
    assert!(fixture.log().contains(
        "[Recovery 1/3] Not resuming: the session was stopped on request during the delay."
    ));
    assert!(!fixture.stored().options.contains_key("recoveryAttempts"));
}

#[test]
fn a_terminate_of_the_exited_container_still_cancels_the_recovery() {
    let fixture = Fixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config()).failing(
        "kill",
        "Error response from daemon: Cannot kill container: box: Container cid is not running",
    );
    let result = fixture.terminate(&runner);
    assert!(result.success, "{:?}", result.error);
    assert!(result
        .output
        .unwrap_or_default()
        .contains("status recovery-cancelled"));
    assert!(fixture.stored().options.contains_key("stopRequestedAt"));

    let outcome = fixture.recover(&FakeRunner::new(updated_host_config()), &|_| {});
    assert_eq!(outcome.reason, "stop-requested");
}

#[test]
fn a_failed_terminate_for_another_reason_still_restores_the_marker() {
    let fixture = Fixture::new(json!({}));
    let runner = FakeRunner::new(updated_host_config()).failing("kill", "permission denied");
    let result = fixture.terminate(&runner);
    assert!(!result.success);
    assert!(!fixture.stored().options.contains_key("stopRequestedAt"));
}
