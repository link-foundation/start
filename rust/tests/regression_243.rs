//! Regression tests for issue #243: `$ --status` decoded the whole store up
//! to three times, and `$ --list` started one or two `docker inspect`
//! processes per record, one after another, including records that had long
//! finished.
//!
//! Now the store is decoded once per content within a process, one batched
//! `docker inspect` answers every probe of a query, and records whose
//! container is already marked removed are not probed at all. The output is
//! the same as before.

use serde_json::Value;
use start_command::docker_inspect_batch::{
    batch_format, parse_batch_inspect, prefetched_inspect, with_docker_inspect_batch,
};
use start_command::execution_store::DECODED_COPY_FILE;
use start_command::status_formatter::{list_executions, query_status};
use start_command::store_decode_cache::{decode_count, forget_decoded_store, DECODED_COPY_FORMAT};
use start_command::{
    ExecutionRecord, ExecutionRecordOptions, ExecutionStatus, ExecutionStore, ExecutionStoreOptions,
};
use std::collections::HashMap;
use std::path::Path;
use tempfile::TempDir;

fn test_store(dir: &Path) -> ExecutionStore {
    ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(dir.to_path_buf()),
        use_links: Some(false),
        verbose: false,
    })
}

fn docker_record(
    session_name: &str,
    status: ExecutionStatus,
    extra: &[(&str, &str)],
) -> ExecutionRecord {
    let mut options = HashMap::new();
    for (key, value) in [
        ("isolated", "docker"),
        ("isolationMode", "detached"),
        ("sessionName", session_name),
    ]
    .iter()
    .chain(extra)
    {
        options.insert(key.to_string(), Value::String(value.to_string()));
    }
    let executed = status == ExecutionStatus::Executed;
    let mut uuid_tail = format!("{:0<12}", session_name.replace('-', ""));
    uuid_tail.truncate(12);
    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: format!("echo {session_name}"),
        uuid: Some(format!("00000243-0000-4000-8000-{uuid_tail}")),
        status: Some(status),
        exit_code: executed.then_some(1),
        start_time: Some(if executed {
            "2026-10-20T09:00:00.000Z".to_string()
        } else {
            "2026-10-20T10:00:00.000Z".to_string()
        }),
        end_time: executed.then(|| "2026-10-20T09:01:00.000Z".to_string()),
        options: Some(options),
        ..Default::default()
    })
}

/// One store with every kind of record `--list` handles.
fn populated_store(dir: &Path) -> (ExecutionStore, HashMap<&'static str, String>) {
    let store = test_store(dir);
    let mut removed = docker_record(
        "removed-e",
        ExecutionStatus::Executed,
        &[("containerId", "eeee5555")],
    );
    removed.container_state = Some("removed".to_string());
    removed.container_removed_observed_at = Some("2026-10-20T09:30:00.000Z".to_string());
    let plain = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo plain".to_string(),
        uuid: Some("00000243-0000-4000-8000-000000000000".to_string()),
        status: Some(ExecutionStatus::Executed),
        exit_code: Some(0),
        start_time: Some("2026-10-20T08:00:00.000Z".to_string()),
        end_time: Some("2026-10-20T08:00:01.000Z".to_string()),
        ..Default::default()
    });
    let records = [
        (
            "running",
            docker_record("run-a", ExecutionStatus::Executing, &[]),
        ),
        (
            "exited",
            docker_record("run-b", ExecutionStatus::Executing, &[]),
        ),
        (
            "kept",
            docker_record(
                "kept-c",
                ExecutionStatus::Executed,
                &[("containerId", "cccc3333")],
            ),
        ),
        (
            "gone",
            docker_record(
                "gone-d",
                ExecutionStatus::Executed,
                &[("containerId", "dddd4444")],
            ),
        ),
        ("removed", removed),
        ("plain", plain),
    ];
    let mut uuids = HashMap::new();
    for (key, record) in records {
        store.save(&record).unwrap();
        uuids.insert(key, record.uuid.clone());
    }
    (store, uuids)
}

/// Query-time clocks, which differ between any two runs.
fn stable(output: &str) -> Value {
    fn strip(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.remove("currentTime");
                map.remove("containerRemovedObservedAt");
                map.values_mut().for_each(strip);
            }
            Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let mut value: Value = serde_json::from_str(output).unwrap();
    strip(&mut value);
    value
}

#[cfg(unix)]
mod fake_docker {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
    use std::sync::{Mutex, OnceLock};

    /// name, id, pid, running, exit code, OOMKilled, started, finished
    const CONTAINERS: &str = "\
run-a aaaa1111 4101 true 0 false 2026-10-20T10:00:00Z 0001-01-01T00:00:00Z
run-b bbbb2222 0 false 0 false 2026-10-20T10:00:00Z 2026-10-20T10:05:00Z
kept-c cccc3333 0 false 1 false 2026-10-20T09:00:00Z 2026-10-20T09:01:00Z
";

    /// Answers `inspect` like Docker 29: one rendered line per found target,
    /// one "No such container" line on stderr per missing one, exit 1 when
    /// any is missing. In legacy mode it rejects `--type`, as a stubbed or
    /// old docker would, so every probe runs on its own as before.
    const SCRIPT: &str = r#"#!/bin/sh
echo "$*" >> "$FAKE_DIR/calls"
[ "$1" = inspect ] || exit 1
shift
if [ "$1" = --type ]; then
  if [ -f "$FAKE_DIR/legacy" ]; then echo 'unknown flag: --type' >&2; exit 125; fi
  shift 2
fi
fmt=$2
shift 2
status=0
for target in "$@"; do
  line=$(awk -v t="$target" '$1 == t || index($2, t) == 1 { print; exit }' "$FAKE_DIR/containers")
  if [ -z "$line" ]; then
    echo "Error response from daemon: No such container: $target" >&2
    status=1
    continue
  fi
  echo "$line" | awk -v f="$fmt" '{
    gsub(/\{\{\.Name\}\}/, "/" $1, f); gsub(/\{\{\.Id\}\}/, $2, f)
    gsub(/\{\{\.State\.Pid\}\}/, $3, f); gsub(/\{\{\.State\.Running\}\}/, $4, f)
    gsub(/\{\{\.State\.ExitCode\}\}/, $5, f); gsub(/\{\{\.State\.OOMKilled\}\}/, $6, f)
    gsub(/\{\{\.State\.StartedAt\}\}/, $7, f); gsub(/\{\{\.State\.FinishedAt\}\}/, $8, f)
    print f }'
done
exit $status
"#;

    /// Run `run` against the fake docker; returns the recorded inspects.
    pub fn with_docker<T>(legacy: bool, run: impl FnOnce() -> T) -> (T, Vec<String>) {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = TempDir::new().unwrap();
        let docker = dir.path().join("docker");
        std::fs::write(&docker, SCRIPT).unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.path().join("containers"), CONTAINERS).unwrap();
        if legacy {
            std::fs::write(dir.path().join("legacy"), "").unwrap();
        }
        let original = std::env::var_os("START_DOCKER_BIN");
        std::env::set_var("START_DOCKER_BIN", &docker);
        std::env::set_var("FAKE_DIR", dir.path());
        let result = catch_unwind(AssertUnwindSafe(run));
        match original {
            Some(value) => std::env::set_var("START_DOCKER_BIN", value),
            None => std::env::remove_var("START_DOCKER_BIN"),
        }
        std::env::remove_var("FAKE_DIR");
        let value = result.unwrap_or_else(|payload| resume_unwind(payload));
        let calls = std::fs::read_to_string(dir.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .filter(|line| line.starts_with("inspect"))
            .map(str::to_string)
            .collect();
        (value, calls)
    }

    fn list_json(legacy: bool) -> (Value, Vec<String>) {
        with_docker(legacy, || {
            let temp = TempDir::new().unwrap();
            let (store, _) = populated_store(temp.path());
            let result = list_executions(Some(&store), Some("json"));
            assert!(result.success, "{:?}", result.error);
            stable(&result.output.unwrap())
        })
    }

    #[test]
    fn lists_every_docker_record_with_one_docker_process() {
        let (legacy, legacy_calls) = list_json(true);
        let (batched, batched_calls) = list_json(false);
        // Before: one or two probes per docker record, after the rejected batch.
        assert!(legacy_calls.len() > 5, "{legacy_calls:?}");
        assert_eq!(batched_calls.len(), 1, "{batched_calls:?}");
        assert!(batched_calls[0]
            .starts_with(&format!("inspect --type container -f {}", batch_format())));
        assert_eq!(batched, legacy);
    }

    #[test]
    fn never_asks_docker_about_a_container_already_marked_removed() {
        let (_, calls) = with_docker(false, || {
            let temp = TempDir::new().unwrap();
            let (store, uuids) = populated_store(temp.path());
            list_executions(Some(&store), Some("json"));
            query_status(Some(&store), &uuids["removed"], Some("json"));
        });
        for call in calls {
            assert!(!call.contains("removed-e"), "{call}");
            assert!(!call.contains("eeee5555"), "{call}");
        }
    }

    #[test]
    fn answers_status_with_one_docker_inspect() {
        let run = |legacy| {
            with_docker(legacy, || {
                let temp = TempDir::new().unwrap();
                let (store, uuids) = populated_store(temp.path());
                let result = query_status(Some(&store), &uuids["kept"], Some("json"));
                assert!(result.success, "{:?}", result.error);
                stable(&result.output.unwrap())
            })
        };
        let (legacy, legacy_calls) = run(true);
        let (batched, batched_calls) = run(false);
        assert!(legacy_calls.len() >= 3, "{legacy_calls:?}");
        assert_eq!(batched_calls.len(), 1, "{batched_calls:?}");
        assert_eq!(batched, legacy);
        assert_eq!(batched["processIds"]["containerId"], "cccc3333");
    }

    #[test]
    fn still_records_a_removal_the_batch_observed() {
        with_docker(false, || {
            let temp = TempDir::new().unwrap();
            let (store, uuids) = populated_store(temp.path());
            let result = query_status(Some(&store), &uuids["gone"], Some("json"));
            assert_eq!(stable(&result.output.unwrap())["containerState"], "removed");
            assert_eq!(
                store
                    .get(&uuids["gone"])
                    .unwrap()
                    .container_state
                    .as_deref(),
                Some("removed")
            );
        });
    }

    #[test]
    fn renders_the_per_record_templates_from_the_batch_only_inside_a_query() {
        assert!(prefetched_inspect("{{.Id}}", "kept-c").is_none());
        with_docker(false, || {
            let records = [
                docker_record("kept-c", ExecutionStatus::Executed, &[]),
                docker_record("nope", ExecutionStatus::Executed, &[]),
            ];
            with_docker_inspect_batch(&records, || {
                let answer = prefetched_inspect("{{.Id}} {{.State.Pid}}", "kept-c").unwrap();
                assert!(answer.success);
                assert_eq!(answer.stdout, "cccc3333 0\n");
                assert!(prefetched_inspect("{{.Config.Image}}", "kept-c").is_none());
                let missing = prefetched_inspect("{{.Id}}", "nope").unwrap();
                assert!(!missing.success);
                assert!(missing.stderr.contains("No such container: nope"));
                assert!(prefetched_inspect("{{.Id}}", "unrelated").is_none());
            });
        });
        assert!(prefetched_inspect("{{.Id}}", "kept-c").is_none());
    }
}

fn row(name: &str, id: &str) -> String {
    format!("/{name} {id} 7 true 0 false s f")
}

#[test]
fn matches_lines_by_name_or_id_prefix_not_by_order() {
    let targets = vec!["beta".to_string(), "aaaa".to_string()];
    let stdout = format!(
        "{}\n{}\n",
        row("alpha", "aaaa9999"),
        row("beta", "bbbb0000")
    );
    let answers = parse_batch_inspect(&targets, &stdout, "");
    assert_eq!(answers["beta"].as_ref().unwrap()[".Id"], "bbbb0000");
    assert_eq!(answers["aaaa"].as_ref().unwrap()[".Name"], "/alpha");
}

#[test]
fn takes_dockers_not_found_over_another_containers_id_prefix() {
    let targets = vec!["bbbb".to_string(), "gone".to_string()];
    let answers = parse_batch_inspect(
        &targets,
        &format!("{}\n", row("beta", "bbbb0000")),
        "Error response from daemon: No such container: gone\n",
    );
    assert!(answers["gone"].is_none());
    assert!(answers.contains_key("bbbb"));
}

#[test]
fn leaves_targets_it_cannot_account_for_to_their_own_probe() {
    let answers = parse_batch_inspect(
        &["x".to_string()],
        "false 1 false\n",
        "unknown flag: --type",
    );
    assert!(!answers.contains_key("x"));
}

#[test]
fn decodes_once_for_every_read_of_an_unchanged_file() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let record = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo one".to_string(),
        exit_code: Some(0),
        ..Default::default()
    });
    store.save(&record).unwrap();
    let path = temp.path().join("executions.lino");
    forget_decoded_store(Some(&path));
    assert!(query_status(Some(&store), &record.uuid, Some("json")).success);
    store.get_all();
    store.get(&record.uuid);
    assert_eq!(decode_count(&path), 1);
}

#[test]
fn sees_every_write_and_hands_out_independent_copies() {
    let temp = TempDir::new().unwrap();
    let store = test_store(temp.path());
    let one = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo one".to_string(),
        exit_code: Some(0),
        ..Default::default()
    });
    store.save(&one).unwrap();
    let mut first = store.get_all();
    first[0].command = "mutated".to_string();
    assert_eq!(store.get_all()[0].command, "echo one");

    // Another store object (as another process would) writes the file.
    let other = test_store(temp.path());
    other
        .save(&ExecutionRecord::with_options(ExecutionRecordOptions {
            command: "echo two".to_string(),
            exit_code: Some(0),
            ..Default::default()
        }))
        .unwrap();
    let mut commands: Vec<String> = store.get_all().into_iter().map(|r| r.command).collect();
    commands.sort();
    assert_eq!(commands, ["echo one", "echo two"]);
}

fn store_with_one_record(dir: &Path) -> ExecutionStore {
    let store = test_store(dir);
    let mut options = HashMap::new();
    options.insert("isolated".to_string(), Value::String("docker".to_string()));
    options.insert(
        "nested".to_string(),
        serde_json::json!({ "list": [1, "a", null] }),
    );
    store
        .save(&ExecutionRecord::with_options(ExecutionRecordOptions {
            command: "echo one".to_string(),
            exit_code: Some(0),
            options: Some(options),
            ..Default::default()
        }))
        .unwrap();
    store
}

#[test]
fn the_next_process_reads_the_copy_instead_of_decoding() {
    let temp = TempDir::new().unwrap();
    let store = store_with_one_record(temp.path());
    let path = temp.path().join("executions.lino");
    let decoded = store.get_all();
    let copy: Value = serde_json::from_str(
        &std::fs::read_to_string(temp.path().join(DECODED_COPY_FILE)).unwrap(),
    )
    .unwrap();
    assert_eq!(copy["format"], DECODED_COPY_FORMAT);
    assert_eq!(copy["sha256"].as_str().unwrap().len(), 64);

    // A new process starts with an empty in-memory cache.
    forget_decoded_store(Some(&path));
    let reread = store.get_all();
    assert_eq!(
        serde_json::to_value(&reread).unwrap(),
        serde_json::to_value(&decoded).unwrap()
    );
    assert_eq!(decode_count(&path), 0);
}

#[test]
fn decodes_again_when_the_copy_is_of_other_content_or_damaged() {
    let temp = TempDir::new().unwrap();
    let store = store_with_one_record(temp.path());
    let path = temp.path().join("executions.lino");
    let copy_path = temp.path().join(DECODED_COPY_FILE);
    store.get_all();
    let stale = std::fs::read_to_string(&copy_path).unwrap();
    test_store(temp.path())
        .save(&ExecutionRecord::with_options(ExecutionRecordOptions {
            command: "echo two".to_string(),
            exit_code: Some(0),
            ..Default::default()
        }))
        .unwrap();
    std::fs::write(&copy_path, stale).unwrap();
    forget_decoded_store(Some(&path));
    assert!(store.get_all().iter().any(|r| r.command == "echo two"));
    assert_eq!(decode_count(&path), 1);

    std::fs::write(&copy_path, "{not json").unwrap();
    forget_decoded_store(Some(&path));
    assert_eq!(store.get_all().len(), 2);
    assert_eq!(decode_count(&path), 1);
}
