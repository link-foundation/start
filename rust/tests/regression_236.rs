//! Docker soft memory limits must survive launch and every resume path.
use serde_json::json;
use start_command::docker_resource_options::{resolve, specs};
use start_command::execution_resume::resume_execution_with_resources;
use start_command::{
    parse_args, CommandRunOutput, CommandRunner, ExecutionRecord, ExecutionStatus,
    IsolationOptions, IsolationResult, ResumeHooks,
};
#[path = "support/issue_176.rs"]
mod support;
use support::*;

struct Daemon;
impl CommandRunner for Daemon {
    fn run(&self, _: &str, args: &[String]) -> CommandRunOutput {
        assert_eq!(args[0], "info");
        ok(&json!({"MemTotal":10737418240_u64,"NCPU":8}).to_string())
    }
}

#[test]
fn parses_reported_command_and_forwards_both_limits() {
    for reservation in [
        vec!["--memory-reservation", "64m"],
        vec!["--memory-reservation=64m"],
    ] {
        let mut argv = vec![
            "--isolated",
            "docker",
            "--image",
            "alpine:3.20",
            "--memory",
            "256m",
        ];
        argv.extend(reservation);
        argv.extend(["--", "echo", "hi"]);
        let parsed = parse_args(&args(&argv)).unwrap();
        assert_eq!(
            parsed.wrapper_options.memory_reservation.as_deref(),
            Some("64m")
        );
        let (limits, values) =
            resolve(&specs(&parsed.wrapper_options), &[], &Daemon, || 0.5).unwrap();
        let argv = start_command::isolation::build_docker_runtime_args(&IsolationOptions {
            resource_limits: limits,
            ..Default::default()
        });
        assert!(argv.contains(&"--memory=268435456".into()));
        assert!(argv.contains(&"--memory-reservation=67108864".into()));
        assert_eq!(values["memoryReservation"], 67108864);
    }
}

#[test]
fn daemon_percentages_ranges_and_stored_values() {
    let (limits, values) = resolve(
        &json!({"memory":"50%","memoryReservation":"10%-20%"}),
        &[],
        &Daemon,
        || 0.5,
    )
    .unwrap();
    assert_eq!(values["memoryReservation"], 1610612736);
    assert_eq!(
        resolve(&json!({}), &limits, &Daemon, || panic!("unexpected draw"))
            .unwrap()
            .0,
        limits
    );
}

#[test]
fn refuses_reservation_at_or_above_new_or_inherited_memory() {
    for (spec, base) in [
        (json!({"memory":"256m","memoryReservation":"512m"}), vec![]),
        (json!({"memory":"256m","memoryReservation":"256m"}), vec![]),
        (
            json!({"memoryReservation":"512m"}),
            args(&["--memory=256m"]),
        ),
        (
            json!({"memory":"32m"}),
            args(&["--memory=256m", "--memory-reservation=64m"]),
        ),
    ] {
        assert_eq!(
            resolve(&spec, &base, &Daemon, || 0.5).unwrap_err(),
            "memory-reservation must be less than memory"
        );
    }
    assert_eq!(
        resolve(&json!({"memoryReservation":"64m"}), &[], &Daemon, || 0.5)
            .unwrap()
            .0,
        args(&["--memory-reservation=67108864"])
    );
}

#[test]
fn validates_reservation_input_and_isolation() {
    for value in ["0m", "0%", "101%", "10watts", "20%-10%", ""] {
        assert!(parse_args(&args(&[
            "--isolated",
            "docker",
            &format!("--memory-reservation={}", value),
            "--",
            "true"
        ]))
        .is_err());
    }
    assert!(parse_args(&args(&["--isolated", "docker", "--memory-reservation"])).is_err());
    assert!(
        parse_args(&args(&["--memory-reservation=64m", "--", "true"]))
            .unwrap_err()
            .contains("Resource options require Docker")
    );
}

struct Hooks;
impl ResumeHooks for Hooks {
    fn start_watcher(&self, _: &str, _: &ExecutionRecord) {}
    fn relaunch(&self, _: &str, _: &str, options: &IsolationOptions) -> IsolationResult {
        assert!(options
            .resource_limits
            .contains(&"--memory-reservation=67108864".into()));
        IsolationResult {
            success: true,
            ..Default::default()
        }
    }
    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        record.clone()
    }
}

#[test]
fn preserves_or_overrides_reservation_on_every_resume_path() {
    for mode in ["start", "snapshot", "missing", "override", "invalid"] {
        let dir = tempfile::TempDir::new().unwrap();
        let store = test_store(dir.path());
        let record = docker_record(
            ExecutionStatus::Executed,
            Some(&dir.path().join("run.log")),
            json!({
                "resourceLimits":["--memory=268435456","--memory-swap=268435456","--memory-reservation=67108864"],
                "resolvedLimits":{"memory":268435456,"memorySwap":268435456,"memoryReservation":67108864},
                "resourceLimitSpecs":{"memory":"256m","memoryReservation":"64m"}
            }),
        );
        store.save(&record).unwrap();
        let mut runner = FakeRunner::new(
            json!({"Memory":268435456,"MemorySwap":268435456,"MemoryReservation":67108864}),
        );
        if mode == "missing" {
            runner = runner.failing("inspect", "No such container");
        }
        let overrides = match mode {
            "override" => json!({"memoryReservation":"32m"}),
            "invalid" => json!({"memory":"32m"}),
            _ => json!({}),
        };
        let result = resume_execution_with_resources(
            Some(&store),
            &record.uuid,
            (mode == "snapshot").then_some("new"),
            None,
            &runner,
            &Hooks,
            &with_test_lock(dir.path(), overrides),
        );
        assert_eq!(
            result.success,
            mode != "invalid",
            "{}: {:?}",
            mode,
            result.error
        );
        if mode == "invalid" {
            assert!(result
                .error
                .unwrap()
                .contains("memory-reservation must be less than memory"));
            assert!(!runner
                .verbs()
                .iter()
                .any(|v| ["start", "run", "update", "commit"].contains(&v.as_str())));
        } else {
            let current = store.get(&record.uuid).unwrap();
            let bytes = if mode == "override" {
                33554432
            } else {
                67108864
            };
            assert_eq!(
                current.options["resolvedLimits"]["memoryReservation"],
                bytes
            );
            assert_eq!(
                current.options["resourceLimitSpecs"]["memoryReservation"],
                if mode == "override" { "32m" } else { "64m" }
            );
            for format in ["json", "text", "links-notation"] {
                let output = start_command::format_record(&current, format).unwrap();
                assert!(output.contains("memoryReservation"));
                assert!(output.contains(&bytes.to_string()));
            }
            if mode == "override" {
                assert!(runner
                    .call("update")
                    .unwrap()
                    .contains(&format!("--memory-reservation={}", bytes)));
                let verbs = runner.verbs();
                assert!(
                    verbs.iter().position(|s| s == "update")
                        < verbs.iter().position(|s| s == "start")
                );
            }
            if mode == "snapshot" {
                let argv = runner.call("run").unwrap();
                assert!(argv.iter().any(|s| [
                    "--memory-reservation=64m",
                    "--memory-reservation=67108864"
                ]
                .contains(&s.as_str())));
            }
        }
    }
}

#[test]
fn refuses_reservation_override_for_non_docker_execution() {
    let mut record = docker_record(
        ExecutionStatus::Executed,
        None,
        json!({"isolated":"screen"}),
    );
    record.options.remove("sessionName");
    assert!(start_command::resume_resources::prepare(
        &record,
        &stopped_probe(),
        &json!({"memoryReservation":"64m"}),
        &Daemon
    )
    .unwrap_err()
    .contains("Resource overrides require a Docker execution"));
}

#[test]
fn reservation_override_survives_failed_docker_update() {
    let dir = tempfile::TempDir::new().unwrap();
    let store = test_store(dir.path());
    let record = docker_record(ExecutionStatus::Executed, None, json!({}));
    store.save(&record).unwrap();
    let runner = FakeRunner::new(json!({"Memory":268435456})).failing("update", "rejected");
    let result = resume_execution_with_resources(
        Some(&store),
        &record.uuid,
        None,
        None,
        &runner,
        &Hooks,
        &with_test_lock(dir.path(), json!({"memoryReservation":"64m"})),
    );
    assert!(!result.success);
    assert!(runner.call("start").is_none());
    assert_eq!(
        store.get(&record.uuid).unwrap().status,
        ExecutionStatus::Executed
    );
}
