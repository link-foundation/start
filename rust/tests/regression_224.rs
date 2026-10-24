//! Issue #224: options, lock and disk waits, size hint and `--cleanup
//! <execution>` of a Docker snapshot resume. The resume flow itself is
//! covered by regression_224_resume.rs.
use serde_json::{json, Value};
use start_command::docker_snapshot_resume::{commit_with_progress, SnapshotReporter};
use start_command::docker_snapshot_safety::{
    acquire_snapshot_lock_with, preflight_snapshot_guarded, PreflightOptions, SnapshotLockRequest,
    EX_TEMPFAIL,
};
use start_command::execution_cleanup::{chain_images, cleanup_execution};
use start_command::snapshot_resume_options::validate_with_env;
use start_command::{
    parse_args, CommandRunOutput, CommandRunner, ExecutionRecord, ExecutionRecordOptions,
    ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const GIB: u64 = 1 << 30;

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn ok(stdout: &str) -> CommandRunOutput {
    CommandRunOutput {
        success: true,
        stdout: stdout.to_string(),
        stderr: String::new(),
        status: Some(0),
        error: None,
    }
}

fn fail(stderr: &str) -> CommandRunOutput {
    CommandRunOutput {
        success: false,
        stdout: String::new(),
        stderr: stderr.to_string(),
        status: Some(1),
        error: None,
    }
}

type Answer = Box<dyn Fn(&[String]) -> Option<CommandRunOutput>>;

/// Fake docker; `answer` may override a call by returning a result.
struct Docker {
    calls: RefCell<Vec<Vec<String>>>,
    answer: Answer,
}

impl Docker {
    fn new() -> Self {
        Self::with(|_| None)
    }

    fn with(answer: impl Fn(&[String]) -> Option<CommandRunOutput> + 'static) -> Self {
        Docker {
            calls: RefCell::new(Vec::new()),
            answer: Box::new(answer),
        }
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.borrow().clone()
    }
}

impl CommandRunner for Docker {
    fn run(&self, _command: &str, args: &[String]) -> CommandRunOutput {
        self.calls.borrow_mut().push(args.to_vec());
        if let Some(answer) = (self.answer)(args) {
            return answer;
        }
        if args[0] == "info" {
            return ok(&json!({"DockerRootDir": "/docker"}).to_string());
        }
        if args.iter().any(|arg| arg == "--size") {
            return ok(&GIB.to_string());
        }
        ok("")
    }
}

mod options {
    use super::*;

    #[test]
    fn parses_every_new_option_in_both_forms_and_keeps_them_on_resume() {
        let parsed = parse_args(&args(&[
            "--resume",
            "box",
            "--snapshot-wait",
            "600",
            "--snapshot-disk-wait=1800",
            "--remove-original-after",
            "30",
            "--snapshot-size-hint=12g",
            "--snapshot-prepare",
            "rm -rf /workspace/target",
        ]))
        .unwrap();
        let snapshot = &parsed.wrapper_options.snapshot;
        assert_eq!(snapshot.wait, Some(600.0));
        assert_eq!(snapshot.disk_wait, Some(1800.0));
        assert_eq!(snapshot.remove_original_after, Some(30.0));
        assert_eq!(snapshot.size_hint, Some(12 * GIB));
        assert_eq!(
            snapshot.prepare.as_deref(),
            Some("rm -rf /workspace/target")
        );
        // A startup window is a removal request.
        assert!(parsed.wrapper_options.remove_original);
    }

    #[test]
    fn accepts_fractions_and_plain_byte_counts() {
        let parsed = parse_args(&args(&[
            "--resume=box",
            "--snapshot-wait=0.5",
            "--snapshot-size-hint",
            "1024",
        ]))
        .unwrap();
        assert_eq!(parsed.wrapper_options.snapshot.wait, Some(0.5));
        assert_eq!(parsed.wrapper_options.snapshot.size_hint, Some(1024));
    }

    #[test]
    fn rejects_the_options_outside_resume_and_malformed_values() {
        for flag in [
            "--snapshot-wait=1",
            "--snapshot-disk-wait=1",
            "--remove-original-after=1",
            "--snapshot-size-hint=1",
            "--snapshot-prepare=true",
        ] {
            let name = flag.split('=').next().unwrap();
            let error = parse_args(&args(&[flag, "--", "echo"])).unwrap_err();
            assert_eq!(error, format!("{} is only valid with --resume", name));
        }
        let error = |values: &[&str]| parse_args(&args(values)).unwrap_err();
        assert!(error(&["--resume", "box", "--snapshot-wait", "-1"])
            .contains("requires a seconds argument"));
        assert!(error(&["--resume", "box", "--snapshot-wait=soon"])
            .contains("Invalid --snapshot-wait value"));
        assert!(error(&["--resume", "box", "--snapshot-size-hint=12 GiB"])
            .contains("Invalid --snapshot-size-hint value"));
        assert!(error(&["--resume", "box", "--snapshot-prepare="]).contains("non-empty command"));
    }

    #[test]
    fn takes_both_waits_from_the_environment_unless_a_flag_sets_them() {
        let env = |lock: &'static str| {
            move |name: &str| match name {
                "START_SNAPSHOT_LOCK_WAIT" => Some(lock.to_string()),
                "START_SNAPSHOT_DISK_WAIT" => Some("60".to_string()),
                _ => None,
            }
        };
        let mut from_env = parse_args(&args(&["--resume", "box"]))
            .unwrap()
            .wrapper_options;
        validate_with_env(&mut from_env, &env("120")).unwrap();
        assert_eq!(from_env.snapshot.wait, Some(120.0));
        assert_eq!(from_env.snapshot.disk_wait, Some(60.0));
        let mut from_flag = parse_args(&args(&["--resume", "box", "--snapshot-wait=5"]))
            .unwrap()
            .wrapper_options;
        validate_with_env(&mut from_flag, &env("120")).unwrap();
        assert_eq!(from_flag.snapshot.wait, Some(5.0));
        // Other modes ignore the variables.
        let mut status = parse_args(&args(&["--status", "box"]))
            .unwrap()
            .wrapper_options;
        validate_with_env(&mut status, &env("120")).unwrap();
        assert_eq!(status.snapshot.wait, None);
        let mut bad = parse_args(&args(&["--resume", "box"]))
            .unwrap()
            .wrapper_options;
        bad.snapshot.wait = None;
        let error = validate_with_env(&mut bad, &env("later")).unwrap_err();
        assert!(error.contains("START_SNAPSHOT_LOCK_WAIT"), "{}", error);
    }

    #[test]
    fn gives_cleanup_and_cleanup_dry_run_an_optional_execution() {
        let options = |values: &[&str]| parse_args(&args(values)).unwrap().wrapper_options;
        assert_eq!(options(&["--cleanup"]).cleanup_target, None);
        let target = options(&["--cleanup", "box"]);
        assert!(target.cleanup && !target.cleanup_dry_run);
        assert_eq!(target.cleanup_target.as_deref(), Some("box"));
        let dry = options(&["--cleanup-dry-run=box"]);
        assert!(dry.cleanup && dry.cleanup_dry_run);
        assert_eq!(dry.cleanup_target.as_deref(), Some("box"));
        assert!(parse_args(&args(&["--cleanup="]))
            .unwrap_err()
            .contains("requires a UUID"));
    }
}

/// Hold the snapshot lock on another thread until the returned sender drops.
fn hold_lock(path: &std::path::Path, holder: &'static str) -> std::sync::mpsc::Sender<()> {
    let (release, released) = std::sync::mpsc::channel::<()>();
    let (ready, is_ready) = std::sync::mpsc::channel::<()>();
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        let lock = acquire_snapshot_lock_with(&SnapshotLockRequest {
            lock_path: Some(path),
            holder: Some(holder),
            ..Default::default()
        })
        .unwrap();
        ready.send(()).unwrap();
        let _ = released.recv();
        drop(lock);
    });
    is_ready.recv_timeout(Duration::from_secs(10)).unwrap();
    release
}

mod snapshot_lock {
    use super::*;

    #[test]
    fn fails_fast_with_exit_code_75_and_names_the_holder_by_default() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("snapshot.lock");
        let _held = hold_lock(&path, "task-a");
        let error = acquire_snapshot_lock_with(&SnapshotLockRequest {
            lock_path: Some(path),
            holder: Some("task-b"),
            ..Default::default()
        })
        .err()
        .unwrap();
        assert_eq!(error.exit_code, Some(EX_TEMPFAIL));
        assert!(error.message.contains("resume of task-a is in progress"));
        assert!(error.message.contains("--snapshot-wait"));
    }

    #[test]
    fn waits_for_the_holder_with_snapshot_wait_and_says_so_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("snapshot.lock");
        let held = hold_lock(&path, "task-a");
        // The waiter polls for 1 s before it reads the holder's name.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(3000));
            drop(held);
        });
        let lines = Mutex::new(Vec::<String>::new());
        let notify = |line: &str| lines.lock().unwrap().push(line.to_string());
        let started = Instant::now();
        let lock = acquire_snapshot_lock_with(&SnapshotLockRequest {
            lock_path: Some(path.clone()),
            holder: Some("task-b"),
            wait_seconds: 20.0,
            notify: &notify,
        })
        .unwrap();
        assert!(started.elapsed() > Duration::from_millis(900));
        assert_eq!(
            *lines.lock().unwrap(),
            vec!["[Resume] Waiting up to 20s for the snapshot of task-a to finish before snapshotting task-b."]
        );
        // The new holder is published for the next waiter.
        let data: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(data["holder"], "task-b");
        drop(lock);
    }

    #[test]
    fn gives_up_with_exit_code_75_when_the_wait_runs_out() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("snapshot.lock");
        let _held = hold_lock(&path, "task-a");
        let error = acquire_snapshot_lock_with(&SnapshotLockRequest {
            lock_path: Some(path),
            holder: Some("task-b"),
            wait_seconds: 1.5,
            notify: &|_| {},
        })
        .err()
        .unwrap();
        assert_eq!(error.exit_code, Some(EX_TEMPFAIL));
        assert!(
            error.message.contains("Still busy after waiting 1.5s"),
            "{}",
            error.message
        );
    }
}

mod disk_wait {
    use super::*;

    struct Clock(Cell<f64>);

    impl Clock {
        fn now(&self) -> f64 {
            self.0.get()
        }

        fn sleep(&self, duration: Duration) {
            self.0.set(self.0.get() + duration.as_secs_f64());
        }
    }

    #[test]
    fn re_checks_free_space_until_it_suffices_measuring_the_layer_once() {
        let docker = Docker::new();
        let free = RefCell::new(vec![5 * GIB, 8 * GIB, 40 * GIB]);
        let lines = RefCell::new(Vec::<String>::new());
        let clock = Clock(Cell::new(0.0));
        let message = preflight_snapshot_guarded(
            "box",
            &docker,
            &PreflightOptions {
                disk_wait_seconds: 600.0,
                disk_poll_seconds: Some(10.0),
                notify: &|line| lines.borrow_mut().push(line.to_string()),
                sleep: &|duration| clock.sleep(duration),
                now: &|| clock.now(),
                ..Default::default()
            },
            &|_| Ok(free.borrow_mut().remove(0)),
        )
        .unwrap();
        assert!(message.contains("(12.00 GiB required)"), "{}", message);
        let sized = docker
            .calls()
            .iter()
            .filter(|call| call.contains(&"--size".to_string()))
            .count();
        assert_eq!(sized, 1);
        let lines = lines.borrow();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with(
            "[Resume] Waiting up to 600s for disk: Insufficient disk at /docker: need 12.00 GiB"
        ));
        assert_eq!(clock.now(), 20.0);
    }

    #[test]
    fn refuses_with_exit_code_75_when_the_wait_runs_out_or_at_once_without_one() {
        let clock = Clock(Cell::new(0.0));
        let error = preflight_snapshot_guarded(
            "box",
            &Docker::new(),
            &PreflightOptions {
                disk_wait_seconds: 30.0,
                disk_poll_seconds: Some(10.0),
                notify: &|_| {},
                sleep: &|duration| clock.sleep(duration),
                now: &|| clock.now(),
                ..Default::default()
            },
            &|_| Ok(GIB),
        )
        .unwrap_err();
        assert_eq!(error.exit_code, Some(EX_TEMPFAIL));
        assert!(error.message.contains("Still short after waiting 30s"));
        let error = preflight_snapshot_guarded(
            "box",
            &Docker::new(),
            &PreflightOptions::default(),
            &|_| Ok(GIB),
        )
        .unwrap_err();
        assert_eq!(error.exit_code, Some(EX_TEMPFAIL));
        assert!(error.message.contains("Docker snapshot resume refused"));
    }

    #[test]
    fn keeps_exit_code_1_for_a_layer_it_cannot_measure() {
        let docker = Docker::with(|args| (args[0] == "inspect").then(|| fail("boom")));
        let error =
            preflight_snapshot_guarded("box", &docker, &PreflightOptions::default(), &|_| {
                Ok(100 * GIB)
            })
            .unwrap_err();
        assert!(error.message.contains("writable layer size"));
        assert_eq!(error.exit_code, None);
    }

    #[test]
    fn size_hint_skips_docker_inspect_size() {
        let docker = Docker::new();
        let message = preflight_snapshot_guarded(
            "box",
            &docker,
            &PreflightOptions {
                size_hint: Some(4 * GIB),
                ..Default::default()
            },
            &|_| Ok(100 * GIB),
        )
        .unwrap();
        assert!(!docker
            .calls()
            .iter()
            .any(|call| call.contains(&"--size".to_string())));
        assert_eq!(
            message,
            "[Resume] snapshotting 4.00 GiB (size hint); disk preflight passed (18.00 GiB required)."
        );
    }
}

#[test]
fn writes_elapsed_time_lines_to_the_log_while_the_commit_runs() {
    struct Slow;
    impl CommandRunner for Slow {
        fn run(&self, _: &str, _: &[String]) -> CommandRunOutput {
            std::thread::sleep(Duration::from_millis(400));
            ok("sha")
        }
    }
    let dir = tempfile::TempDir::new().unwrap();
    let log_path = dir.path().join("execution.log");
    let lines = Mutex::new(Vec::<String>::new());
    let notify = |line: &str| lines.lock().unwrap().push(line.to_string());
    let reporter = SnapshotReporter {
        log_path: log_path.to_str().unwrap(),
        notify: &notify,
    };
    let result = commit_with_progress(
        &Slow,
        "docker",
        &args(&["commit", "box", "image"]),
        "box",
        &reporter,
        0.05,
    );
    assert_eq!(result.stdout, "sha");
    let log = std::fs::read_to_string(&log_path).unwrap();
    let log: Vec<&str> = log.trim().lines().collect();
    assert!(log.len() > 2, "{:?}", log);
    assert_eq!(
        log[0],
        "[Resume] snapshotting box: 0s elapsed (docker commit reports no progress)"
    );
    assert_eq!(
        *log.last().unwrap(),
        "[Resume] snapshot of box committed after 0s"
    );
    assert_eq!(*lines.lock().unwrap(), log);
}

mod cleanup {
    use super::*;

    fn chain_record(options: Value) -> ExecutionRecord {
        let options: HashMap<String, Value> = serde_json::from_value(options).unwrap();
        ExecutionRecord::with_options(ExecutionRecordOptions {
            command: "true".to_string(),
            status: Some(ExecutionStatus::Executed),
            exit_code: Some(0),
            options: Some(options),
            ..Default::default()
        })
    }

    fn docker_chain() -> ExecutionRecord {
        chain_record(json!({
            "isolated": "docker",
            "isolationMode": "detached",
            "sessionName": "box-resume-1-resume-2",
            "sessionNameHistory": ["box", "box-resume-1"],
            "snapshotImage": "start-command-resume/box-resume-1:2",
            "containerId": "c0ffee",
        }))
    }

    fn store_with(dir: &std::path::Path, record: &ExecutionRecord) -> ExecutionStore {
        let store = ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(dir.to_path_buf()),
            use_links: Some(false),
            verbose: false,
        });
        store.save(record).unwrap();
        store
    }

    fn gone(kind: &str, args: &[String]) -> CommandRunOutput {
        fail(&format!(
            "Error response from daemon: No such {}: {}",
            kind,
            args.last().unwrap()
        ))
    }

    fn removals(docker: &Docker) -> Vec<Vec<String>> {
        docker
            .calls()
            .into_iter()
            .filter(|call| call[0] == "rm" || call[0] == "rmi")
            .collect()
    }

    #[test]
    fn derives_the_images_of_a_resume_chain_newest_first() {
        assert_eq!(
            chain_images("box-resume-1-resume-2"),
            vec![
                "start-command-resume/box-resume-1:2",
                "start-command-resume/box:1"
            ]
        );
        assert!(chain_images("box").is_empty());
    }

    #[test]
    fn removes_the_containers_then_their_snapshot_images_never_forced() {
        let dir = tempfile::TempDir::new().unwrap();
        let record = docker_chain();
        let store = store_with(dir.path(), &record);
        let docker = Docker::with(|args| match args[0].as_str() {
            "inspect" if args.last().unwrap() == "box-resume-1" => {
                Some(ok("start-command-resume/box:1\n"))
            }
            "inspect" => Some(gone("container", args)),
            "rm" if args.last().unwrap() == "box" => Some(gone("container", args)),
            _ => None,
        });
        let result = cleanup_execution(Some(&store), &record.uuid, false, &docker);
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            removals(&docker),
            vec![
                args(&["rm", "box-resume-1-resume-2"]),
                args(&["rm", "box-resume-1"]),
                args(&["rm", "box"]),
                args(&["rmi", "start-command-resume/box-resume-1:2"]),
                args(&["rmi", "start-command-resume/box:1"]),
            ]
        );
        assert_eq!(
            result.output.unwrap().lines().collect::<Vec<_>>(),
            vec![
                "Removed container box-resume-1-resume-2",
                "Removed container box-resume-1",
                "Already gone: container box",
                "Removed image start-command-resume/box-resume-1:2",
                "Removed image start-command-resume/box:1",
            ]
        );
        // Issue #225: the status now says the container is gone.
        assert_eq!(
            store.get(&record.uuid).unwrap().container_state.as_deref(),
            Some("removed")
        );
    }

    #[test]
    fn reports_what_docker_keeps_and_fails_without_forcing_it() {
        let dir = tempfile::TempDir::new().unwrap();
        let record = docker_chain();
        let store = store_with(dir.path(), &record);
        let docker = Docker::with(|args| {
            match args[0].as_str() {
            "inspect" => Some(gone("container", args)),
            "rmi" if args.last().unwrap().ends_with(":1") => Some(fail(
                "Error response from daemon: conflict: unable to remove repository reference (must force) - container 1234 is using its referenced image",
            )),
            _ => None,
        }
        });
        let result = cleanup_execution(Some(&store), &record.uuid, false, &docker);
        assert!(!result.success);
        assert!(result.output.unwrap().contains(
            "Retained image start-command-resume/box:1 (Error response from daemon: conflict"
        ));
        assert_eq!(
            result.error.as_deref(),
            Some("1 Docker object(s) retained; nothing was forced.")
        );
        assert!(!docker.calls().iter().any(|call| call
            .iter()
            .any(|arg| arg == "-f" && call[0] != "inspect")
            || call.contains(&"--force".to_string())));
    }

    #[test]
    fn only_lists_with_cleanup_dry_run() {
        let dir = tempfile::TempDir::new().unwrap();
        let record = docker_chain();
        let store = store_with(dir.path(), &record);
        let docker = Docker::with(|args| match args[0].as_str() {
            "image" => Some(gone("image", args)),
            "inspect" => Some(gone("container", args)),
            _ => None,
        });
        let result = cleanup_execution(Some(&store), &record.uuid, true, &docker);
        assert!(result.success);
        assert!(removals(&docker).is_empty());
        let output = result.output.unwrap();
        assert_eq!(
            output.lines().next(),
            Some("Would remove container box-resume-1-resume-2")
        );
        assert!(output.contains("Already gone: image start-command-resume/box:1"));
        assert_eq!(store.get(&record.uuid).unwrap().container_state, None);
    }

    #[test]
    fn refuses_unknown_and_non_docker_executions() {
        let dir = tempfile::TempDir::new().unwrap();
        let record = chain_record(json!({"isolated": "screen", "sessionName": "s"}));
        let store = store_with(dir.path(), &record);
        let docker = Docker::new();
        let missing = cleanup_execution(Some(&store), "missing", false, &docker);
        assert!(missing.error.unwrap().contains("No execution found"));
        let screen = cleanup_execution(Some(&store), "s", false, &docker);
        assert!(screen.error.unwrap().contains("is not a Docker execution"));
        assert!(docker.calls().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn runs_from_the_command_line_with_a_stub_docker() {
        use std::os::unix::fs::PermissionsExt;
        let app = tempfile::TempDir::new().unwrap();
        store_with(app.path(), &docker_chain());
        let bin = tempfile::TempDir::new().unwrap();
        let docker = bin.path().join("docker");
        let calls = bin.path().join("calls");
        std::fs::write(
            &docker,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\ncase \"$1\" in\n  inspect) echo \"no such object: $4\" >&2; exit 1;;\n  rm|rmi) exit 0;;\nesac\nexit 1\n",
                calls.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run = std::process::Command::new(env!("CARGO_BIN_EXE_start"))
            .args(["--cleanup", "box"])
            .env("START_APP_FOLDER", app.path())
            .env("START_DOCKER_BIN", &docker)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&run.stdout);
        assert_eq!(String::from_utf8_lossy(&run.stderr), "");
        assert_eq!(run.status.code(), Some(0), "{}", stdout);
        assert!(stdout.contains("Removed container box-resume-1-resume-2"));
        assert!(stdout.contains("Removed image start-command-resume/box:1"));
        let calls = std::fs::read_to_string(&calls).unwrap();
        let removals: Vec<&str> = calls
            .lines()
            .filter(|line| line.starts_with("rm ") || line.starts_with("rmi "))
            .collect();
        assert_eq!(removals.len(), 5, "{:?}", removals);
        assert!(!removals.iter().any(|line| line
            .split_whitespace()
            .any(|arg| arg == "-f" || arg == "--force")));
    }
}
