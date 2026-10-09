use start_command::execution_store::LockManager;
use std::fs;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

#[test]
fn malformed_old_locks_do_not_block_future_writes() {
    for text in ["".to_string(), "{\"pid\":".to_string(), serde_json::json!({"pid":std::process::id().to_string(),"timestamp":0,"hostname":start_command::launch_owner::hostname()}).to_string()] {
        let temp = TempDir::new().unwrap();
        let file = temp.path().join("executions.lock");
        fs::write(&file, text).unwrap();
        let handle = fs::OpenOptions::new().write(true).open(&file).unwrap();
        handle
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(10)),
            )
            .unwrap();
        let mut lock = LockManager::new(file.clone());
        assert!(lock.acquire(300));
        lock.release();
        assert!(!file.exists());
    }
}

#[test]
fn fresh_incomplete_lock_has_a_grace_period() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("executions.lock");
    fs::write(&file, "").unwrap();
    assert!(!LockManager::new(file).acquire(100));
}

#[test]
fn concurrent_database_writers_preserve_all_records() {
    use start_command::{ExecutionRecord, ExecutionStore, ExecutionStoreOptions};
    let dir = TempDir::new().unwrap();
    std::thread::scope(|scope| {
        for n in 0..8 {
            let path = dir.path();
            scope.spawn(move || {
                let store = ExecutionStore::with_options(ExecutionStoreOptions {
                    app_folder: Some(path.into()),
                    use_links: Some(false),
                    verbose: false,
                });
                store
                    .save(&ExecutionRecord::new(&format!("writer {}", n)))
                    .unwrap();
            });
        }
    });
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.path().into()),
        use_links: Some(false),
        verbose: false,
    });
    assert_eq!(store.get_all().len(), 8);
}
#[test]
fn dead_launcher_does_not_permanently_block_resume() {
    use start_command::launch_owner::has_active_launch;
    use start_command::ExecutionRecord;
    let mut record = ExecutionRecord::new("work");
    record
        .options
        .insert("launchPending".into(), serde_json::json!(true));
    record.options.insert(
        "launchOwner".into(),
        serde_json::json!({"pid":2147483647,"hostname":start_command::launch_owner::hostname()}),
    );
    assert!(!has_active_launch(&record));
    record.options.insert("launchOwner".into(),serde_json::json!({"pid":std::process::id(),"hostname":start_command::launch_owner::hostname()}));
    assert!(has_active_launch(&record));
}

#[path = "support/issue_176.rs"]
mod support;
use start_command::{
    CommandRunOutput, CommandRunner, ExecutionRecord, ExecutionStatus, ExecutionStore,
    IsolationOptions, IsolationResult, ResumeHooks,
};
use std::cell::Cell;
use std::path::{Path, PathBuf};
use support::*;
struct Hooks(Cell<bool>);
impl ResumeHooks for Hooks {
    fn start_watcher(&self, _: &str, _: &ExecutionRecord) {
        self.0.set(true);
    }
    fn relaunch(&self, _: &str, _: &str, _: &IsolationOptions) -> IsolationResult {
        unreachable!()
    }
    fn reconcile(&self, record: &ExecutionRecord) -> ExecutionRecord {
        record.clone()
    }
}
struct ReservationRunner<'a> {
    store: &'a ExecutionStore,
    uuid: String,
    folder: PathBuf,
    fail_after_launch: bool,
    fake: FakeRunner,
}
impl CommandRunner for ReservationRunner<'_> {
    fn run(&self, command: &str, args: &[String]) -> CommandRunOutput {
        match args[0].as_str() {
            "commit" | "run" => {
                let saved = self.store.get(&self.uuid).unwrap();
                assert_eq!(saved.options["sessionName"], "box-resume-1");
                assert_eq!(saved.options["launchPending"], true);
                assert!(saved.attempt.unwrap().launch_accepted_at.is_none());
                // A second writer can acquire the store while Docker work runs.
                self.store
                    .save(&ExecutionRecord::new("concurrent writer"))
                    .unwrap();
                if args[0] == "run" && self.fail_after_launch {
                    fs::rename(&self.folder, self.folder.with_extension("backup")).unwrap();
                    fs::write(&self.folder, "blocked store directory").unwrap();
                }
            }
            "stop" if self.fail_after_launch => {
                fs::remove_file(&self.folder).unwrap();
                fs::rename(self.folder.with_extension("backup"), &self.folder).unwrap();
            }
            _ => {}
        }
        self.fake.run(command, args)
    }
}
fn reservation_case(folder: &Path, fail: bool) {
    let store = test_store(folder);
    let record = docker_record(ExecutionStatus::Executed, None, serde_json::json!({}));
    store.save(&record).unwrap();
    let runner = ReservationRunner {
        store: &store,
        uuid: record.uuid.clone(),
        folder: folder.into(),
        fail_after_launch: fail,
        fake: FakeRunner::new(serde_json::json!({})),
    };
    let hooks = Hooks(Cell::new(false));
    let result = start_command::execution_resume::resume_execution_with(
        Some(&store),
        &record.uuid,
        Some("new"),
        Some("json"),
        &runner,
        &hooks,
    );
    assert!(hooks.0.get());
    if fail {
        assert!(!result.success);
        let error: serde_json::Value = serde_json::from_str(&result.error.unwrap()).unwrap();
        assert_eq!(error["code"], "LAUNCH_PERSISTENCE_FAILED");
        assert_eq!(error["containerName"], "box-resume-1");
        assert_eq!(error["running"], false);
        assert!(runner.fake.call("stop").is_some());
        assert_eq!(
            store.get(&record.uuid).unwrap().options["launchPending"],
            false
        );
    } else {
        assert!(result.success, "{:?}", result.error);
    }
}
#[test]
fn launch_is_reserved_without_holding_store_lock_over_docker() {
    let dir = TempDir::new().unwrap();
    reservation_case(&dir.path().join("store"), false);
}
#[test]
fn accepted_launch_with_failed_final_save_attaches_watcher_and_stops_with_identity() {
    let dir = TempDir::new().unwrap();
    reservation_case(&dir.path().join("store"), true);
}
