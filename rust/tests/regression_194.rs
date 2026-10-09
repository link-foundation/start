use start_command::exit_reason::{resolve_exit_reason, resolve_memory_exhaustion};
#[test]
fn historical_child_oom_does_not_explain_later_sigkill() {
    assert_eq!(
        resolve_exit_reason(Some(137), None, Some(true), Some(3)),
        Some("signal (SIGKILL; cause unknown)".into())
    );
    assert!(resolve_memory_exhaustion(Some(137), None, Some(true), Some(3)).is_none());
}

use start_command::exit_evidence::{self, DAEMON_RESTART, MAIN_OOM};
#[test]
fn only_fresh_well_formed_deltas_qualify() {
    let finished = "1970-01-01T00:01:40Z";
    assert!(exit_evidence::recent_oom_delta(
        "64 63 3 2 100 100",
        finished
    ));
    for sample in [
        "64 63 3 2",
        "64 63 3 2 0 100",
        "64 63 3 2 95 100",
        "64 63 3 2 101 100",
        "64 63 3 2 nope 100",
        "64 63 3 2 9223372036854775807 9223372036854775807",
    ] {
        assert!(!exit_evidence::recent_oom_delta(sample, finished));
    }
    assert_eq!(
        resolve_exit_reason(Some(137), Some(MAIN_OOM), Some(true), Some(2)).as_deref(),
        Some("memory-exhaustion (cgroup-oom-killer)")
    );
}
#[test]
fn daemon_restart_requires_matching_container_and_service_evidence() {
    let id = "a".repeat(64);
    let journal=format!("docker.service: Main process exited\nContainer failed to exit within 10s of signal 15 - using the force container={}",id);
    assert!(exit_evidence::daemon_restart_evidence(&journal, &id));
    assert!(!exit_evidence::daemon_restart_evidence(
        "many containers finished together",
        &id
    ));
    assert!(!exit_evidence::daemon_restart_evidence(
        &journal,
        &"b".repeat(64)
    ));
    for oom in [true, false] {
        assert_eq!(
            resolve_exit_reason(Some(137), Some(DAEMON_RESTART), Some(oom), Some(2)).as_deref(),
            Some("killed (docker daemon restart)")
        );
        assert!(
            resolve_memory_exhaustion(Some(137), Some(DAEMON_RESTART), Some(oom), Some(2))
                .is_none()
        );
    }
}
#[test]
fn finalization_keeps_evidence_even_without_a_log() {
    use start_command::{
        enrich_detached_status, finalize_detached_execution, DetachedFinalizeFacts,
        ExecutionRecord, ExecutionStore, ExecutionStoreOptions,
    };
    let dir = tempfile::TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.path().into()),
        use_links: Some(false),
        verbose: false,
    });
    let record = ExecutionRecord::new("work");
    store.save(&record).unwrap();
    finalize_detached_execution(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "137".into(),
            oom_killed: "true".into(),
            finished_at: "1970-01-01T00:01:40Z".into(),
            cgroup_memory: "64 63 3 2 100 100".into(),
            running: "false".into(),
            ..Default::default()
        },
    );
    let current = store.get(&record.uuid).unwrap();
    assert_eq!(current.options["exitEvidence"]["mainOom"], true);
    assert_eq!(
        enrich_detached_status(&current).exit_reason.as_deref(),
        Some("memory-exhaustion (cgroup-oom-killer)")
    );
}

#[test]
fn finalization_preserves_logged_main_evidence_without_a_sample() {
    use start_command::{
        enrich_detached_status, finalize_detached_execution, DetachedFinalizeFacts,
        ExecutionRecord, ExecutionStore, ExecutionStoreOptions,
    };
    let dir = tempfile::TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.path().into()),
        use_links: Some(false),
        verbose: false,
    });
    let mut record = ExecutionRecord::new("work");
    record.log_path = dir.path().join("task.log").to_string_lossy().into();
    std::fs::write(&record.log_path, format!("{}\n", MAIN_OOM)).unwrap();
    store.save(&record).unwrap();
    finalize_detached_execution(
        &store,
        &record.uuid,
        &DetachedFinalizeFacts {
            exit_code: "137".into(),
            oom_killed: "true".into(),
            finished_at: "1970-01-01T00:01:40Z".into(),
            running: "false".into(),
            ..Default::default()
        },
    );
    let current = store.get(&record.uuid).unwrap();
    assert_eq!(current.options["exitEvidence"]["mainOom"], true);
    std::fs::remove_file(&record.log_path).unwrap();
    assert_eq!(
        enrich_detached_status(&current).exit_reason.as_deref(),
        Some("memory-exhaustion (cgroup-oom-killer)")
    );
}

#[test]
fn ordinary_exits_remain_final_even_with_a_main_evidence_marker() {
    for exit in [0, 1] {
        assert!(
            resolve_memory_exhaustion(Some(exit), Some(MAIN_OOM), Some(true), Some(3)).is_none()
        );
        assert!(resolve_exit_reason(Some(exit), Some(MAIN_OOM), Some(true), Some(3)).is_none());
    }
}
