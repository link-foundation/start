//! Tests for status_formatter module
//!
//! Tests for execution record formatting in various output formats.

use serde_json::Value;
use start_command::{
    attach_current_time, enrich_detached_status, format_record, format_record_as_links_notation,
    format_record_as_links_notation_with_current_time, format_record_as_text,
    format_record_as_text_with_current_time, format_record_list, format_record_with_current_time,
    list_executions, query_status, ExecutionRecord, ExecutionRecordOptions, ExecutionStatus,
    ExecutionStore, ExecutionStoreOptions,
};
use std::collections::HashMap;
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tempfile::TempDir;

fn create_test_record() -> ExecutionRecord {
    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "echo hello".to_string(),
        uuid: Some("test-uuid-1234".to_string()),
        pid: Some(12345),
        status: Some(ExecutionStatus::Executed),
        exit_code: Some(0),
        log_path: Some("/tmp/test.log".to_string()),
        start_time: Some("2025-01-01T00:00:00Z".to_string()),
        end_time: Some("2025-01-01T00:00:01Z".to_string()),
        working_directory: Some("/home/user".to_string()),
        shell: Some("/bin/bash".to_string()),
        platform: Some("linux".to_string()),
        ..Default::default()
    })
}

#[test]
fn test_format_record_as_links_notation() {
    let record = create_test_record();
    let output = format_record_as_links_notation(&record);

    // Should start with the UUID on its own line
    assert!(output.starts_with("test-uuid-1234\n"));
    // Should contain indented properties (values may or may not be quoted based on content)
    assert!(output.contains("  uuid test-uuid-1234"));
    assert!(output.contains("  status executed"));
    // command with space should be quoted
    assert!(output.contains("  command \"echo hello\""));
}

#[test]
fn test_format_record_as_text() {
    let record = create_test_record();
    let output = format_record_as_text(&record);

    assert!(output.contains("Execution Status"));
    assert!(output.contains("UUID:              test-uuid-1234"));
    assert!(output.contains("Status:            executed"));
    assert!(output.contains("Command:           echo hello"));
    assert!(output.contains("Exit Code:         0"));
    assert!(output.contains("PID:               12345"));
}

#[test]
fn test_format_record_as_json() {
    let record = create_test_record();
    let output = format_record(&record, "json").unwrap();

    // Parse the JSON to verify it's valid
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["uuid"], "test-uuid-1234");
    assert_eq!(parsed["command"], "echo hello");
    assert_eq!(parsed["status"], "executed");
}

#[test]
fn test_format_record_invalid_format() {
    let record = create_test_record();
    let result = format_record(&record, "invalid");
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Unknown output format"));
}

#[test]
fn test_query_status_no_store() {
    let result = query_status(None, "some-uuid", None);
    assert!(!result.success);
    assert!(result.error.unwrap().contains("tracking is disabled"));
}

#[test]
fn test_query_status_not_found() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });

    let result = query_status(Some(&store), "nonexistent-uuid", None);
    assert!(!result.success);
    assert!(result.error.unwrap().contains("No execution found"));
}

#[test]
fn test_query_status_success() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });

    let record = create_test_record();
    store.save(&record).unwrap();

    let result = query_status(Some(&store), "test-uuid-1234", Some("json"));
    assert!(result.success);
    assert!(result.output.is_some());

    let output = result.output.unwrap();
    assert!(output.contains("test-uuid-1234"));
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["processIds"]["wrapperPid"], 12345);
}

#[test]
fn test_query_status_default_format() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });

    let record = create_test_record();
    store.save(&record).unwrap();

    // Default format should be links-notation (indented style)
    let result = query_status(Some(&store), "test-uuid-1234", None);
    assert!(result.success);
    let output = result.output.unwrap();

    // Should be in links-notation indented format
    assert!(output.starts_with("test-uuid-1234\n"));
    // UUID without special chars is not quoted
    assert!(output.contains("  uuid test-uuid-1234"));
}

#[test]
fn test_format_record_list_as_links_notation() {
    let executing = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        uuid: Some("test-executing-uuid".to_string()),
        pid: Some(54321),
        status: Some(ExecutionStatus::Executing),
        start_time: Some("2026-04-24T10:00:00Z".to_string()),
        ..Default::default()
    });
    let mut completed = create_test_record();
    completed.start_time = "2026-04-24T09:00:00Z".to_string();

    let records = vec![executing, completed];
    let output =
        format_record_list(&records, "links-notation").expect("links-notation list should format");

    assert!(output.starts_with("executions\n"));
    assert!(output.contains("  count 2"));
    assert!(output.contains("    test-executing-uuid"));
    assert!(output.contains("      status executing"));
    assert!(output.contains("      command \"sleep 60\""));
    assert!(output.contains("    test-uuid-1234"));
    assert!(output.contains("      status executed"));
}

#[test]
fn test_list_executions_json_includes_all_records() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });

    let completed = create_test_record();
    let executing = ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        uuid: Some("test-executing-uuid".to_string()),
        pid: Some(54321),
        status: Some(ExecutionStatus::Executing),
        start_time: Some("2026-04-24T10:00:00Z".to_string()),
        ..Default::default()
    });
    store.save(&completed).unwrap();
    store.save(&executing).unwrap();

    let result = list_executions(Some(&store), Some("json"));
    assert!(result.success);
    let output = result.output.unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["count"], 2);
    assert_eq!(parsed["executions"].as_array().unwrap().len(), 2);
    assert!(parsed["executions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|record| record["uuid"] == "test-uuid-1234"));
    let executing_json = parsed["executions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["uuid"] == "test-executing-uuid")
        .unwrap();
    assert_eq!(executing_json["status"], "executing");
    assert_eq!(executing_json["processIds"]["wrapperPid"], 54321);
    assert!(executing_json.get("currentTime").is_some());
}

#[test]
fn test_list_executions_empty_store() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });

    let result = list_executions(Some(&store), None);
    assert!(result.success);
    let output = result.output.unwrap();
    assert!(output.starts_with("executions\n"));
    assert!(output.contains("  count 0"));
    assert!(output.contains("  records ()"));
}

#[test]
fn test_list_executions_no_store() {
    let result = list_executions(None, None);
    assert!(!result.success);
    assert!(result.error.unwrap().contains("tracking is disabled"));
}

fn docker_record() -> ExecutionRecord {
    let mut options = HashMap::new();
    options.insert(
        "sessionName".to_string(),
        Value::String("issue144-oom".to_string()),
    );
    options.insert("isolated".to_string(), Value::String("docker".to_string()));
    options.insert(
        "isolationMode".to_string(),
        Value::String("detached".to_string()),
    );

    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sh -c 'exit 0'".to_string(),
        uuid: Some("issue144-rust".to_string()),
        log_path: Some("/tmp/issue144.log".to_string()),
        options: Some(options),
        ..Default::default()
    })
}

fn write_fake_docker(fake_dir: &Path, state_line: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let script = [
            "@echo off",
            "if not \"%1\"==\"inspect\" exit /b 1",
            "echo %3 | findstr /C:\"State.Pid\" >nul",
            "if %errorlevel%==0 (",
            "  echo fake-container-id 4321",
            "  exit /b 0",
            ")",
            &format!("echo {}", state_line),
            "exit /b 0",
            "",
        ]
        .join("\r\n");
        let docker_path = fake_dir.join("docker.cmd");
        std::fs::write(&docker_path, script).unwrap();
        docker_path
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;

        let script = [
            "#!/bin/sh",
            "[ \"$1\" = \"inspect\" ] || exit 1",
            "case \"$3\" in",
            "  *State.Pid*) echo \"fake-container-id 4321\" ;;",
            &format!("  *) echo \"{}\" ;;", state_line),
            "esac",
            "",
        ]
        .join("\n");
        let docker_path = fake_dir.join("docker");
        std::fs::write(&docker_path, script).unwrap();
        let mut permissions = std::fs::metadata(&docker_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&docker_path, permissions).unwrap();
        docker_path
    }
}

/// A fake `docker` whose every `inspect` fails, i.e. the container is gone
/// (removed) or not visible yet — the "unknown liveness" case of issue #136.
fn write_missing_container_docker(fake_dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let script = ["@echo off", "exit /b 1", ""].join("\r\n");
        let docker_path = fake_dir.join("docker.cmd");
        std::fs::write(&docker_path, script).unwrap();
        docker_path
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;

        let script = ["#!/bin/sh", "exit 1", ""].join("\n");
        let docker_path = fake_dir.join("docker");
        std::fs::write(&docker_path, script).unwrap();
        let mut permissions = std::fs::metadata(&docker_path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&docker_path, permissions).unwrap();
        docker_path
    }
}

fn with_fake_docker<F: FnOnce()>(write_docker: impl FnOnce(&Path) -> PathBuf, run: F) {
    static FAKE_DOCKER_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = FAKE_DOCKER_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let fake_dir = TempDir::new().unwrap();
    let docker_path = write_docker(fake_dir.path());
    let original_path = std::env::var_os("PATH");
    let original_docker_bin = std::env::var_os("START_DOCKER_BIN");
    let mut paths = vec![fake_dir.path().to_path_buf()];
    if let Some(existing) = original_path.as_ref() {
        paths.extend(std::env::split_paths(existing));
    }
    let joined = std::env::join_paths(paths).unwrap();
    std::env::set_var("PATH", &joined);
    std::env::set_var("START_DOCKER_BIN", &docker_path);
    let result = catch_unwind(AssertUnwindSafe(run));
    if let Some(path) = original_path {
        std::env::set_var("PATH", path);
    } else {
        std::env::remove_var("PATH");
    }
    if let Some(path) = original_docker_bin {
        std::env::set_var("START_DOCKER_BIN", path);
    } else {
        std::env::remove_var("START_DOCKER_BIN");
    }
    if let Err(payload) = result {
        resume_unwind(payload);
    }
}

fn with_fake_docker_inspect<F: FnOnce()>(state_line: &str, run: F) {
    with_fake_docker(|dir| write_fake_docker(dir, state_line), run);
}

fn with_fake_docker_missing_container<F: FnOnce()>(run: F) {
    with_fake_docker(write_missing_container_docker, run);
}

#[test]
fn docker_oom_killed_is_exposed_in_status_and_list_output() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    let record = docker_record();
    store.save(&record).unwrap();

    with_fake_docker_inspect("false 0 true", || {
        let json_result = query_status(Some(&store), "issue144-rust", Some("json"));
        assert!(json_result.success);
        let parsed: Value = serde_json::from_str(&json_result.output.unwrap()).unwrap();
        assert_eq!(parsed["status"], "executed");
        assert_eq!(parsed["exitCode"], 0);
        assert_eq!(parsed["oomKilled"], true);

        let links_result = query_status(Some(&store), "issue144-rust", Some("links-notation"));
        assert!(links_result.success);
        assert!(links_result.output.unwrap().contains("  oomKilled true"));

        let text_result = query_status(Some(&store), "issue144-rust", Some("text"));
        assert!(text_result.success);
        assert!(text_result
            .output
            .unwrap()
            .contains("OOM Killed:        true"));

        let list_result = list_executions(Some(&store), Some("json"));
        assert!(list_result.success);
        let listed: Value = serde_json::from_str(&list_result.output.unwrap()).unwrap();
        assert_eq!(listed["count"], 1);
        assert_eq!(listed["executions"][0]["status"], "executed");
        assert_eq!(listed["executions"][0]["exitCode"], 0);
        assert_eq!(listed["executions"][0]["oomKilled"], true);
    });
}

/// Issue #148: an OOM-killed session whose container is already gone and which
/// wrote no `Exit Code:` footer must still become terminal, with the
/// conventional SIGKILL code as the last-resort fallback.
#[test]
fn docker_oom_killed_is_terminal_once_the_container_is_gone() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    let mut record = docker_record();
    record.log_path = "/nonexistent-issue148.log".to_string();
    record.oom_killed = Some(true);
    store.save(&record).unwrap();

    with_fake_docker_missing_container(|| {
        let json_result = query_status(Some(&store), "issue144-rust", Some("json"));
        assert!(json_result.success);
        let parsed: Value = serde_json::from_str(&json_result.output.unwrap()).unwrap();
        assert_eq!(parsed["status"], "executed");
        assert_eq!(parsed["exitCode"], 137);
        assert_eq!(parsed["oomKilled"], true);
        assert!(parsed.get("endTime").is_some());
        assert!(parsed.get("currentTime").is_none());
    });
}

/// Issue #151: `State.OOMKilled` is a container-cgroup flag that is never
/// cleared, so it must stay an observation — only the container's own state may
/// decide `status` / `exitCode`.
#[test]
fn docker_oom_killed_keeps_running_container_executing() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    let record = docker_record();
    store.save(&record).unwrap();

    with_fake_docker_inspect("true 0 true", || {
        let json_result = query_status(Some(&store), "issue144-rust", Some("json"));
        assert!(json_result.success);
        let parsed: Value = serde_json::from_str(&json_result.output.unwrap()).unwrap();
        assert_eq!(parsed["status"], "executing");
        assert_eq!(parsed["exitCode"], Value::Null);
        assert_eq!(parsed["oomKilled"], true);
        assert_eq!(parsed["endTime"], Value::Null);
        assert!(parsed.get("currentTime").is_some());

        let list_result = list_executions(Some(&store), Some("json"));
        assert!(list_result.success);
        let listed: Value = serde_json::from_str(&list_result.output.unwrap()).unwrap();
        assert_eq!(listed["executions"][0]["status"], "executing");
        assert_eq!(listed["executions"][0]["exitCode"], Value::Null);
        assert_eq!(listed["executions"][0]["oomKilled"], true);
    });
}

#[test]
fn docker_oom_killed_never_synthesizes_137_for_a_running_container() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    let record = docker_record();
    store.save(&record).unwrap();

    with_fake_docker_inspect("true 137 true", || {
        let enriched = enrich_detached_status(&store.get("issue144-rust").unwrap());
        assert_eq!(enriched.status, ExecutionStatus::Executing);
        assert_eq!(enriched.exit_code, None);
        assert_eq!(enriched.oom_killed, Some(true));
    });
}

#[test]
fn docker_oom_killed_uses_the_container_exit_code_when_it_stops() {
    let temp_dir = TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    let record = docker_record();
    store.save(&record).unwrap();

    with_fake_docker_inspect("false 3 true", || {
        let json_result = query_status(Some(&store), "issue144-rust", Some("json"));
        assert!(json_result.success);
        let parsed: Value = serde_json::from_str(&json_result.output.unwrap()).unwrap();
        assert_eq!(parsed["status"], "executed");
        assert_eq!(parsed["exitCode"], 3);
        assert_eq!(parsed["oomKilled"], true);
        assert!(parsed.get("endTime").is_some());
    });
}

#[test]
fn docker_oom_killed_prefers_the_log_footer_over_the_137_fallback() {
    let temp_dir = TempDir::new().unwrap();
    let log_path = temp_dir.path().join("issue-151.log");
    // The anchored footer block `start` itself writes (issue #150).
    std::fs::write(
        &log_path,
        "==================================================\nFinished: now\nExit Code: 0\n",
    )
    .unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(false),
        verbose: false,
    });
    let mut record = docker_record();
    record.log_path = log_path.to_string_lossy().to_string();
    record.oom_killed = Some(true);
    store.save(&record).unwrap();

    with_fake_docker_missing_container(|| {
        let json_result = query_status(Some(&store), "issue144-rust", Some("json"));
        assert!(json_result.success);
        let parsed: Value = serde_json::from_str(&json_result.output.unwrap()).unwrap();
        assert_eq!(parsed["status"], "executed");
        assert_eq!(parsed["exitCode"], 0);
        assert_eq!(parsed["oomKilled"], true);
    });
}

// ===== Issue #105: currentTime in formatter output =====

fn create_executing_record() -> ExecutionRecord {
    ExecutionRecord::with_options(ExecutionRecordOptions {
        command: "sleep 60".to_string(),
        uuid: Some("test-executing-uuid".to_string()),
        pid: Some(54321),
        status: Some(ExecutionStatus::Executing),
        log_path: Some("/tmp/executing.log".to_string()),
        start_time: Some("2026-04-23T10:00:00Z".to_string()),
        working_directory: Some("/home/user".to_string()),
        shell: Some("/bin/bash".to_string()),
        platform: Some("linux".to_string()),
        ..Default::default()
    })
}

#[test]
fn test_attach_current_time_none_for_completed() {
    let record = create_test_record();
    assert!(attach_current_time(&record).is_none());
}

#[test]
fn test_attach_current_time_some_for_executing() {
    let record = create_executing_record();
    let ct = attach_current_time(&record).expect("executing record should get currentTime");
    assert!(chrono::DateTime::parse_from_rfc3339(&ct).is_ok());
}

#[test]
fn test_links_notation_includes_current_time_when_provided() {
    let record = create_executing_record();
    let output = format_record_as_links_notation_with_current_time(
        &record,
        Some("2026-04-23T10:10:13.042Z"),
    );
    assert!(output.contains("  currentTime \"2026-04-23T10:10:13.042Z\""));
    // currentTime must appear right after startTime
    let start_idx = output.find("  startTime ").expect("startTime present");
    let ct_idx = output.find("  currentTime ").expect("currentTime present");
    assert!(
        ct_idx > start_idx,
        "currentTime must appear after startTime, output: {}",
        output
    );
    let between = &output[start_idx..ct_idx];
    // Only one newline between the two lines (i.e. currentTime is the immediate next line)
    assert_eq!(between.matches('\n').count(), 1);
}

#[test]
fn test_links_notation_no_current_time_when_absent() {
    let record = create_executing_record();
    let output = format_record_as_links_notation_with_current_time(&record, None);
    assert!(!output.contains("currentTime"));
}

#[test]
fn test_text_format_includes_current_time_when_provided() {
    let record = create_executing_record();
    let output = format_record_as_text_with_current_time(&record, Some("2026-04-23T10:10:13.042Z"));
    assert!(output.contains("Current Time:      2026-04-23T10:10:13.042Z"));
    // Current Time must appear between Start Time and End Time
    let start_idx = output.find("Start Time:").expect("Start Time present");
    let current_idx = output.find("Current Time:").expect("Current Time present");
    let end_idx = output.find("End Time:").expect("End Time present");
    assert!(start_idx < current_idx);
    assert!(current_idx < end_idx);
}

#[test]
fn test_text_format_no_current_time_when_absent() {
    let record = create_executing_record();
    let output = format_record_as_text_with_current_time(&record, None);
    assert!(!output.contains("Current Time:"));
}

#[test]
fn test_json_format_includes_current_time_when_provided() {
    let record = create_executing_record();
    let output =
        format_record_with_current_time(&record, "json", Some("2026-04-23T10:10:13.042Z")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["currentTime"], "2026-04-23T10:10:13.042Z");
    assert_eq!(parsed["status"], "executing");
}

#[test]
fn test_json_format_no_current_time_when_absent() {
    let record = create_executing_record();
    let output = format_record_with_current_time(&record, "json", None).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert!(parsed.get("currentTime").is_none());
}

#[test]
fn test_format_record_unchanged_when_no_current_time() {
    let record = create_executing_record();
    assert_eq!(
        format_record(&record, "links-notation").unwrap(),
        format_record_as_links_notation(&record)
    );
    assert_eq!(
        format_record(&record, "text").unwrap(),
        format_record_as_text(&record)
    );
}
