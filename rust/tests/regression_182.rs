//! Regression tests for issue #182:
//!
//! Docker's `State.OOMKilled` is container-wide and sticky (moby/moby#43564):
//! it cannot say how many processes the OOM killer took, whether the container
//! hit its own `--memory` limit or the whole host ran out, or how close the run
//! came to its limit. The kernel provides raw counters per cgroup (`memory.events`
//! `oom`/`oom_kill`, `memory.peak`, `memory.max`), but the cgroup is gone once
//! the container stops.
//!
//! The detached watcher now samples the container's cgroup v2 counters while
//! it runs, writes a `Memory:` line into the post-mortem, stores them as
//! `cgroupMemory` in the execution record (shown by `--status`), and hands them
//! to the kill recovery, which notes them in `recoveryHistory`.

use serde_json::json;
use start_command::cgroup_memory::{
    build_cgroup_sampler_start_snippet, build_cgroup_sampler_stop_snippet,
    describe_cgroup_oom_scope, format_cgroup_memory, format_cgroup_memory_log_line,
    parse_cgroup_memory_sample, CgroupMemory, OomScope,
};
use start_command::execution_recovery::{
    build_recovery_snippet, recover_killed_execution, RecoveryFacts,
};
use start_command::status_formatter::format_record_as_text;
use start_command::{
    build_detached_docker_completion_script_with, build_detached_finalize_snippet,
    finalize_detached_execution, DetachedFinalizeFacts, DockerContainerCleanupPolicy,
    DockerWatcherOptions, ExecutionRecord, ExecutionStatus,
};
use tempfile::TempDir;
#[path = "support/issue_176.rs"]
mod support;
use support::*;

const OOM_SAMPLE: &str = "268435456 268300000 0 3";
const OOM_COUNTERS: CgroupMemory = CgroupMemory {
    limit_bytes: Some(268_435_456),
    peak_bytes: Some(268_300_000),
    oom_events: Some(0),
    oom_kills: Some(3),
};
const UNKNOWN_SCOPE_NOTE: &str = "OOM kill scope unknown";

// ---------------------------------------------------------------------------
// Reading cgroup v2 memory counters
// ---------------------------------------------------------------------------

#[test]
fn parses_the_sample_the_watcher_writes() {
    assert_eq!(parse_cgroup_memory_sample(OOM_SAMPLE), Some(OOM_COUNTERS));
    assert_eq!(
        parse_cgroup_memory_sample("max - 1 1\n"),
        Some(CgroupMemory {
            limit_bytes: None,
            peak_bytes: None,
            oom_events: Some(1),
            oom_kills: Some(1),
        })
    );
    for empty in ["", "- - - -", "1 2 3"] {
        assert_eq!(parse_cgroup_memory_sample(empty), None, "{:?}", empty);
    }
}

#[test]
fn leaves_oom_scope_unknown_with_only_raw_counters() {
    assert_eq!(
        describe_cgroup_oom_scope(&OOM_COUNTERS),
        Some(OomScope::Unknown)
    );
    let counters = |oom_events, oom_kills| CgroupMemory {
        oom_events: Some(oom_events),
        oom_kills: Some(oom_kills),
        ..Default::default()
    };
    assert_eq!(
        describe_cgroup_oom_scope(&counters(2, 2)),
        Some(OomScope::Unknown)
    );
    assert_eq!(describe_cgroup_oom_scope(&counters(4, 0)), None);
}

#[test]
fn formats_the_counters_for_status_and_for_the_log() {
    assert_eq!(
        format_cgroup_memory(&OOM_COUNTERS),
        format!(
            "peak 255.9 MiB of 256.0 MiB limit, oom 0, oom_kill 3 ({})",
            UNKNOWN_SCOPE_NOTE
        )
    );
    assert_eq!(
        format_cgroup_memory(&CgroupMemory {
            limit_bytes: None,
            peak_bytes: None,
            oom_events: Some(1),
            oom_kills: Some(1),
        }),
        "peak unknown of no limit, oom 1, oom_kill 1 (OOM kill scope unknown)"
    );
    assert_eq!(
        format_cgroup_memory_log_line("max 1024 0 0").as_deref(),
        Some("Memory:     memory.max=max memory.peak=1024 oom=0 oom_kill=0")
    );
}

#[test]
fn record_field_round_trips_and_reads_javascript_values_leniently() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let mut record = docker_record(ExecutionStatus::Executed, None, json!({}));
    record.cgroup_memory = Some(CgroupMemory {
        limit_bytes: None,
        ..OOM_COUNTERS
    });
    store.save(&record).unwrap();
    assert_eq!(
        store.get(&record.uuid).unwrap().cgroup_memory,
        record.cgroup_memory
    );

    let mut value = record.to_json();
    value["cgroupMemory"] = json!({
        "limitBytes": 268435456.0,
        "peakBytes": "1024",
        "oomEvents": null,
        "oomKills": "x"
    });
    let read = ExecutionRecord::from_json(&value).expect("record stays readable");
    assert_eq!(
        read.cgroup_memory,
        Some(CgroupMemory {
            limit_bytes: Some(268_435_456),
            peak_bytes: Some(1024),
            oom_events: None,
            oom_kills: None,
        })
    );
}

// ---------------------------------------------------------------------------
// The watcher samples the cgroup while the container runs
// ---------------------------------------------------------------------------

#[test]
fn starts_the_sampler_first_and_stops_it_before_reading_the_state() {
    let log_path = std::path::PathBuf::from("/tmp/run.log");
    for log in [Some(&log_path), None] {
        let script = build_detached_docker_completion_script_with(
            "box",
            DockerContainerCleanupPolicy::Default,
            log,
            Some("uuid-182"),
            &DockerWatcherOptions {
                since: None,
                recover_on_kill: true,
            },
        );
        assert!(script.starts_with(&build_cgroup_sampler_start_snippet("box")));
        let stop = script
            .find(&build_cgroup_sampler_stop_snippet())
            .expect("sampler is stopped");
        assert!(stop > script.find("docker wait").unwrap());
        assert!(stop < script.find("__start_command_state=").unwrap());
        assert!(script.contains(&build_detached_finalize_snippet("uuid-182")));
        assert!(script.contains(&build_recovery_snippet("uuid-182")));
    }
    assert!(build_detached_finalize_snippet("u").contains("\"$__start_command_cgroup\" >/dev/null"));
    assert!(build_recovery_snippet("u").contains("\"$__start_command_cgroup\" >/dev/null"));
}

#[cfg(unix)]
mod shell {
    use super::*;
    use start_command::cgroup_memory::build_cgroup_memory_log_snippet;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Output};

    const CONTAINER_ID: &str = "182c000000000000000000000000000000000000000000000000000000000000";
    const KILLED_STATE: &str =
        "137 true 2026-10-01T10:00:00.000000000Z 2026-10-01T10:05:00.000000000Z";

    /// A fake cgroup v2 tree, `/proc` and `docker`. `docker logs` runs the
    /// `during` file after 1.5s, so the sampler has taken a sample by then.
    struct FakeHost {
        temp: TempDir,
        scope: PathBuf,
    }

    impl FakeHost {
        fn new(events: &str, max: &str) -> Self {
            let temp = TempDir::new().unwrap();
            let dir = temp.path();
            let scope = dir
                .join("cgroup/system.slice")
                .join(format!("docker-{}.scope", CONTAINER_ID));
            std::fs::create_dir_all(&scope).unwrap();
            std::fs::write(scope.join("memory.events"), events).unwrap();
            std::fs::write(scope.join("memory.max"), format!("{}\n", max)).unwrap();
            std::fs::write(scope.join("memory.peak"), "268300000\n").unwrap();
            std::fs::create_dir_all(dir.join("proc/4242")).unwrap();
            std::fs::write(
                dir.join("proc/4242/cgroup"),
                format!("0::/system.slice/docker-{}.scope\n", CONTAINER_ID),
            )
            .unwrap();
            std::fs::create_dir_all(dir.join("bin")).unwrap();
            FakeHost { temp, scope }
        }

        fn dir(&self) -> &Path {
            self.temp.path()
        }

        fn write_docker(&self, state: &str, during: &str) {
            std::fs::write(self.dir().join("during"), format!("{}\n", during)).unwrap();
            let docker = self.dir().join("bin/docker");
            std::fs::write(
                &docker,
                [
                    "#!/bin/sh".to_string(),
                    format!("dir='{}'", self.dir().display()),
                    "case \"$1\" in".to_string(),
                    "  inspect)".to_string(),
                    "    case \"$3\" in".to_string(),
                    format!("      *'{{{{.Id}}}}'*) echo {} ;;", CONTAINER_ID),
                    "      *State.Pid*) echo 4242 ;;".to_string(),
                    "      *State.Running*) echo false ;;".to_string(),
                    "      *State.Error*) echo \"\" ;;".to_string(),
                    format!("      *) echo '{}' ;;", state),
                    "    esac ;;".to_string(),
                    "  logs) echo work; sleep 1.5; sh \"$dir/during\" ;;".to_string(),
                    "  rm) echo removed ;;".to_string(),
                    "esac".to_string(),
                    String::new(),
                ]
                .join("\n"),
            )
            .unwrap();
            let mut permissions = std::fs::metadata(&docker).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&docker, permissions).unwrap();
        }

        fn run(&self, script: &str, app_folder: Option<&Path>) -> Output {
            let path = std::env::var("PATH").unwrap_or_default();
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg(script)
                .env(
                    "PATH",
                    format!("{}:{}", self.dir().join("bin").display(), path),
                )
                .env("START_COMMAND_CGROUP_ROOT", self.dir().join("cgroup"))
                .env("START_COMMAND_PROC_ROOT", self.dir().join("proc"))
                .env("TMPDIR", self.dir())
                .env_remove("START_DISABLE_TRACKING");
            if let Some(app_folder) = app_folder {
                command.env("START_APP_FOLDER", app_folder);
            }
            command.output().expect("sh")
        }

        fn leftovers(&self) -> Vec<String> {
            std::fs::read_dir(self.dir())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
                .filter(|name| name.starts_with("start-command-cgroup"))
                .collect()
        }
    }

    struct WatcherRun {
        log: String,
        record: ExecutionRecord,
        leftovers: Vec<String>,
    }

    fn run_watcher(
        events: &str,
        max: &str,
        during: &dyn Fn(&FakeHost) -> String,
        policy: DockerContainerCleanupPolicy,
        state: &str,
    ) -> WatcherRun {
        let host = FakeHost::new(events, max);
        host.write_docker(state, &during(&host));
        let app_folder = host.dir().join("app");
        let store = test_store(&app_folder);
        let log_path = host.dir().join("run.log");
        let record = docker_record(ExecutionStatus::Executing, Some(&log_path), json!({}));
        store.save(&record).unwrap();
        let script = build_detached_docker_completion_script_with(
            "box",
            policy,
            Some(&log_path),
            Some(&record.uuid),
            &DockerWatcherOptions::default(),
        );
        // The finalizer re-invokes the running executable, which here is the
        // test harness; point it at the real `start` binary instead.
        let current_exe = std::env::current_exe().unwrap();
        let script = script.replace(
            current_exe.to_string_lossy().as_ref(),
            env!("CARGO_BIN_EXE_start"),
        );
        let output = host.run(&script, Some(&app_folder));
        assert!(output.status.success(), "watcher failed: {:?}", output);
        WatcherRun {
            log: std::fs::read_to_string(&log_path).unwrap(),
            record: test_store(&app_folder).get(&record.uuid).unwrap(),
            leftovers: host.leftovers(),
        }
    }

    #[test]
    fn keeps_the_last_sample_once_the_cgroup_is_gone() {
        let host = FakeHost::new("oom 0\noom_kill 3\n", "268435456");
        host.write_docker(KILLED_STATE, "");
        let log_path = host.dir().join("log");
        let script = [
            build_cgroup_sampler_start_snippet("box"),
            "sleep 1.5".to_string(),
            format!("rm -rf '{}'", host.scope.display()),
            build_cgroup_sampler_stop_snippet(),
            format!(
                "printf '%s' \"$__start_command_cgroup\" > '{}/sample'",
                host.dir().display()
            ),
            build_cgroup_memory_log_snippet(&format!("'{}'", log_path.display())),
        ]
        .join("; ");
        let output = host.run(&script, None);
        assert!(output.status.success(), "{:?}", output);
        assert_eq!(
            std::fs::read_to_string(host.dir().join("sample")).unwrap(),
            OOM_SAMPLE
        );
        assert_eq!(
            std::fs::read_to_string(&log_path).unwrap(),
            format!("{}\n", format_cgroup_memory_log_line(OOM_SAMPLE).unwrap())
        );
    }

    #[test]
    fn writes_the_counters_into_the_post_mortem_and_the_record() {
        let run = run_watcher(
            "low 0\nhigh 0\nmax 9\noom 1\noom_kill 1\n",
            "268435456",
            // The cgroup outlives the main process for a moment: the final
            // read still sees the kills of the last second.
            &|host| {
                format!(
                    "printf 'oom 1\\noom_kill 3\\n' > '{}/memory.events'",
                    host.scope.display()
                )
            },
            DockerContainerCleanupPolicy::Default,
            KILLED_STATE,
        );
        assert!(
            run.log.contains("Exit Code:  137 (SIGKILL - 128+9)"),
            "{}",
            run.log
        );
        assert!(
            run.log.contains(&format!(
                "Memory:     memory.max=268435456 memory.peak=268300000 oom=1 oom_kill=3 ({})",
                UNKNOWN_SCOPE_NOTE
            )),
            "{}",
            run.log
        );
        assert_eq!(run.record.status, ExecutionStatus::Executed);
        assert_eq!(
            run.record.cgroup_memory,
            Some(CgroupMemory {
                oom_events: Some(1),
                ..OOM_COUNTERS
            })
        );
        assert!(run.leftovers.is_empty(), "{:?}", run.leftovers);
        assert!(format_record_as_text(&run.record)
            .contains("Cgroup Memory:     peak 255.9 MiB of 256.0 MiB limit, oom 1, oom_kill 3"));
    }

    #[test]
    fn notes_the_counters_of_a_removed_container_too() {
        let run = run_watcher(
            "oom 0\noom_kill 0\n",
            "max",
            &|host| format!("rm -rf '{}'", host.scope.display()),
            DockerContainerCleanupPolicy::Always,
            "0 false 2026-10-01T10:00:00.000000000Z 2026-10-01T10:05:00.000000000Z",
        );
        assert!(run.log.contains("Container removed: box"), "{}", run.log);
        assert!(
            run.log
                .contains("Memory:     memory.max=max memory.peak=268300000 oom=0 oom_kill=0\n"),
            "{}",
            run.log
        );
        assert_eq!(
            run.record.cgroup_memory,
            Some(CgroupMemory {
                limit_bytes: None,
                peak_bytes: Some(268_300_000),
                oom_events: Some(0),
                oom_kills: Some(0),
            })
        );
    }
}

// ---------------------------------------------------------------------------
// The finalizer
// ---------------------------------------------------------------------------

fn finalize(exit_code: &str, cgroup_memory: &str) -> ExecutionRecord {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let record = docker_record(ExecutionStatus::Executing, None, json!({}));
    store.save(&record).unwrap();
    let outcome = finalize_detached_execution(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: exit_code.to_string(),
            oom_killed: "false".to_string(),
            finished_at: "2026-10-01T10:05:00Z".to_string(),
            cgroup_memory: cgroup_memory.to_string(),
            ..Default::default()
        },
    );
    assert!(outcome.updated, "{}", outcome.reason);
    store.get(&record.uuid).unwrap()
}

#[test]
fn records_nothing_without_a_cgroup_v2_sample() {
    let stored = finalize("0", "");
    assert_eq!(stored.cgroup_memory, None);
    assert!(stored.to_json().get("cgroupMemory").is_none());
    assert!(!format_record_as_text(&stored).contains("Cgroup Memory"));
}

#[test]
fn explains_an_unknown_exit_with_the_per_run_oom_kill_count() {
    let stored = finalize("137", OOM_SAMPLE);
    assert_eq!(stored.cgroup_memory, Some(OOM_COUNTERS));
    assert!(stored.exit_reason.is_some());
}

// ---------------------------------------------------------------------------
// The kill recovery keeps the killed run's counters
// ---------------------------------------------------------------------------

#[test]
fn recovery_logs_them_and_notes_them_in_recovery_history() {
    let temp = TempDir::new().unwrap();
    let store = test_store(&temp.path().join("app"));
    let log_path = temp.path().join("run.log");
    std::fs::write(&log_path, "main output\n").unwrap();
    let mut record = docker_record(
        ExecutionStatus::Executing,
        Some(&log_path),
        json!({ "onKillResume": 2 }),
    );
    record.cgroup_memory = Some(OOM_COUNTERS);
    store.save(&record).unwrap();
    let outcome = recover_killed_execution(
        &store,
        &record.uuid,
        &RecoveryFacts {
            exit_code: "137".to_string(),
            oom_killed: "true".to_string(),
            started_at: "2026-10-01T10:00:00Z".to_string(),
            finished_at: "2026-10-01T10:05:00Z".to_string(),
            container_error: String::new(),
            cgroup_memory: OOM_SAMPLE.to_string(),
        },
        &FakeRunner::new(json!({})),
        &|_: &str, _: &ExecutionRecord, _: &DockerWatcherOptions| {},
    );
    assert!(outcome.recovered, "{}", outcome.reason);
    let log = std::fs::read_to_string(&log_path).unwrap();
    assert!(
        log.contains(&format!(
            "{}\n\n[Recovery 1/2]",
            format_cgroup_memory_log_line(OOM_SAMPLE).unwrap()
        )),
        "{}",
        log
    );
    let stored = store.get(&record.uuid).unwrap();
    let history = stored.options["recoveryHistory"].as_array().unwrap();
    assert_eq!(history.len(), 1);
    let entry = history[0].as_str().unwrap();
    assert!(
        entry.starts_with("1: exit 137, oomKilled=true, oomEvents=0, oomKills=3, resumed at "),
        "{}",
        entry
    );
    // The resumed run gets a fresh cgroup: the old counters must not explain
    // its exit.
    assert_eq!(stored.cgroup_memory, None);
}
