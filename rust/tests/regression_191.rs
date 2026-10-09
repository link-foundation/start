//! Memory changes must finish before command execution resumes.
use serde_json::json;
use start_command::execution_recovery::{recover_killed_execution, RecoveryFacts};
use start_command::execution_resume::resume_execution_with_resources;
use start_command::{
    CommandRunOutput, CommandRunner, ExecutionRecord, ExecutionStatus, IsolationOptions,
    IsolationResult, ResumeHooks,
};
#[path = "support/issue_176.rs"]
mod support;
use support::*;
struct Hooks;
impl ResumeHooks for Hooks {
    fn start_watcher(&self, _: &str, _: &ExecutionRecord) {}
    fn relaunch(&self, _: &str, _: &str, _: &IsolationOptions) -> IsolationResult {
        IsolationResult {
            success: true,
            ..Default::default()
        }
    }
    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        record.clone()
    }
}
struct Runner(FakeRunner);
impl CommandRunner for Runner {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        if args.first().map(String::as_str) == Some("info") {
            return ok(&json!({"MemTotal":1073741824,"NCPU":4}).to_string());
        }
        self.0.run(command, args)
    }
}
fn runner() -> Runner {
    Runner(FakeRunner::new(
        json!({"Memory":67108864,"MemorySwap":67108864,"NanoCpus":3000000000_i64}),
    ))
}
#[test]
fn manual_memory_override_is_updated_before_start_and_persisted() {
    let dir = tempfile::TempDir::new().unwrap();
    let store = test_store(dir.path());
    let record = docker_record(
        ExecutionStatus::Executed,
        None,
        json!({"resolvedLimits":null,"resourceLimitSpecs":null}),
    );
    store.save(&record).unwrap();
    let runner = runner();
    let result = resume_execution_with_resources(
        Some(&store),
        &record.uuid,
        None,
        Some("json"),
        &runner,
        &Hooks,
        &json!({"memory":"128m"}),
    );
    assert!(result.success, "{:?}", result.error);
    let update = runner.0.call("update").unwrap();
    assert!(update.contains(&"--memory=134217728".into()));
    assert!(update.contains(&"--memory-swap=134217728".into()));
    let verbs = runner.0.verbs();
    assert!(verbs.iter().position(|s| s == "update") < verbs.iter().position(|s| s == "start"));
    assert_eq!(
        store.get(&record.uuid).unwrap().options["resolvedLimits"]["memory"],
        134217728
    );
}
#[test]
fn snapshot_override_is_applied_at_creation() {
    let dir = tempfile::TempDir::new().unwrap();
    let store = test_store(dir.path());
    let record = docker_record(ExecutionStatus::Executed, None, json!({}));
    store.save(&record).unwrap();
    let runner = runner();
    let result = resume_execution_with_resources(
        Some(&store),
        &record.uuid,
        Some("new"),
        None,
        &runner,
        &Hooks,
        &json!({"memory":"128m"}),
    );
    assert!(result.success, "{:?}", result.error);
    assert!(runner
        .0
        .call("run")
        .unwrap()
        .contains(&"--memory=134217728".into()));
}
#[test]
fn recovery_changes_memory_only_for_a_fresh_qualifying_oom() {
    for (exit, oom, sample, change) in [
        ("137", "true", "67108864 66000000 1 1 100 100", true),
        ("137", "true", "67108864 66000000 1 1 0 100", false),
        ("137", "false", "67108864 66000000 0 0 0 100", false),
        ("1", "true", "67108864 66000000 1 1 100 100", false),
    ] {
        let dir = tempfile::TempDir::new().unwrap();
        let store = test_store(dir.path());
        let record = docker_record(
            ExecutionStatus::Executed,
            None,
            json!({"onKillResume":3,"onKillResumeMemory":"70%-80%"}),
        );
        store.save(&record).unwrap();
        let runner = runner();
        let result = recover_killed_execution(
            &store,
            &record.uuid,
            &RecoveryFacts {
                exit_code: exit.into(),
                oom_killed: oom.into(),
                cgroup_memory: sample.into(),
                finished_at: "1970-01-01T00:01:40Z".into(),
                ..Default::default()
            },
            &runner,
            &|_, _, _| {},
        );
        assert_eq!(runner.0.call("update").is_some(), change);
        if change {
            assert!(result.recovered);
            let verbs = runner.0.verbs();
            assert!(
                verbs.iter().position(|s| s == "update") < verbs.iter().position(|s| s == "start")
            );
            let current = store.get(&record.uuid).unwrap();
            let bytes = current.options["resolvedLimits"]["memory"]
                .as_u64()
                .unwrap();
            assert!((751619276..=858993459).contains(&bytes));
            assert_eq!(current.options["resolvedLimits"]["memorySwap"], bytes);
        }
        if exit == "1" {
            assert!(!result.recovered);
        }
    }
}
#[test]
fn failed_update_never_releases_the_command() {
    let dir = tempfile::TempDir::new().unwrap();
    let store = test_store(dir.path());
    let record = docker_record(ExecutionStatus::Executed, None, json!({}));
    store.save(&record).unwrap();
    let runner = Runner(runner().0.failing("update", "update failed"));
    let result = resume_execution_with_resources(
        Some(&store),
        &record.uuid,
        None,
        None,
        &runner,
        &Hooks,
        &json!({"memory":"128m"}),
    );
    assert!(!result.success);
    assert!(runner.0.call("start").is_none());
    assert_eq!(
        store.get(&record.uuid).unwrap().status,
        ExecutionStatus::Executed
    );
}
