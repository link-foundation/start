//! Issue #253: the links database was never written. clink 4.x rejected every
//! query the store built (unbalanced parentheses, `\"` escapes, references to
//! links it would not create), and the failures were only logged. Mirrors
//! js/test/execution-store-clink.js.

use start_command::execution_store::{
    clink_reference, is_clink_installed, ExecutionRecord, ExecutionRecordOptions, ExecutionStore,
    ExecutionStoreOptions,
};
use std::collections::HashMap;
use std::process::Command;

const UUID: &str = "4df9d19e-da50-4a7b-9e97-2c4f15b35a88";

#[test]
#[cfg(unix)]
fn command_stream_mode_keeps_stdout_and_stderr_in_the_log() {
    // Rust uses its native runner for this flag. Keep the observable contract
    // alongside JavaScript's lightweight command-stream/core integration.
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_start"))
        .args([
            "--use-command-stream",
            "--",
            "sh",
            "-c",
            "echo out-253; echo err-253 >&2",
        ])
        .env("START_APP_FOLDER", root.path().join("app"))
        .env("START_LOG_DIR", root.path().join("logs"))
        .env("START_DISABLE_AUTO_ISSUE", "1")
        .env("START_DISABLE_LOG_UPLOAD", "1")
        .env_remove("START_EXECUTION_ID")
        .env_remove("START_ATTEMPT")
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let log = std::fs::read_dir(root.path().join("logs/direct"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let content = std::fs::read_to_string(log).unwrap();
    assert!(content.contains("out-253\n"), "{content}");
    assert!(content.contains("err-253\n"), "{content}");
}

fn make_store(use_links: bool) -> (tempfile::TempDir, ExecutionStore) {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(temp_dir.path().to_path_buf()),
        use_links: Some(use_links),
        verbose: false,
    });
    (temp_dir, store)
}

fn record(uuid: Option<&str>, command: &str) -> ExecutionRecord {
    let mut options = HashMap::new();
    options.insert("isolated".to_string(), serde_json::json!("docker"));
    ExecutionRecord::with_options(ExecutionRecordOptions {
        uuid: uuid.map(str::to_string),
        command: command.to_string(),
        pid: Some(4242),
        options: Some(options),
        ..Default::default()
    })
}

fn paren_depth(text: &str) -> i32 {
    let mut depth = 0;
    let mut in_quote = false;
    for c in text.chars() {
        match c {
            '"' => in_quote = !in_quote,
            '(' if !in_quote => depth += 1,
            ')' if !in_quote => {
                depth -= 1;
                if depth < 0 {
                    return depth;
                }
            }
            _ => {}
        }
    }
    depth
}

fn all_links(store: &ExecutionStore) -> String {
    let output = Command::new("clink")
        .arg("((($id: $s $t)) (($id: $s $t)))")
        .arg("--db")
        .arg(store.get_stats().links_db_path)
        .arg("--changes")
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).to_string()
}

#[test]
fn clink_reference_quotes_text_and_doubles_inner_quotes() {
    assert_eq!(clink_reference("plain"), "\"plain\"");
    assert_eq!(clink_reference("say \"hi\""), "\"say \"\"hi\"\"\"");
    assert_eq!(clink_reference("back\\slash"), "\"back\\slash\"");
}

#[test]
fn create_query_is_one_balanced_group_with_record_scoped_links() {
    let (_dir, store) = make_store(false);
    let mut rec = record(Some(UUID), "echo \"a\" (b)");
    rec.exit_code = Some(0);
    let query = store.build_clink_create_query(&rec);
    let properties = store.record_to_links_notation(&rec);
    assert_eq!(
        query,
        format!("() (({UUID}: ExecutionRecord {UUID}) {properties})")
    );
    assert!(!properties.contains("ExecutionRecord"));

    assert_eq!(paren_depth(&query), 0, "{}", query);
    assert!(query.starts_with(&format!("() (({UUID}: ExecutionRecord {UUID}) ")));
    assert!(query.contains(&format!(
        "({UUID}.command: {UUID} \"command=echo \"\"a\"\" (b)\")"
    )));
    // Numbers carry their key, so clink never reads them as link addresses
    assert!(query.contains(&format!("({UUID}.exitCode: {UUID} \"exitCode=0\")")));
    assert!(query.contains(&format!("({UUID}.pid: {UUID} \"pid=4242\")")));
    assert!(query.contains(&format!(
        "({UUID}.options: {UUID} \"options={{\"\"isolated\"\":\"\"docker\"\"}}\")"
    )));
    assert!(!query.contains("\\\""));
}

#[test]
fn links_database_saves_updates_and_deletes_records_that_share_values() {
    if !is_clink_installed() {
        eprintln!("clink not installed; skipping");
        return;
    }
    let (_dir, store) = make_store(true);
    let mut first = record(None, "echo 'it''s' \"quoted\" (x) \\ done");
    // Same status, pid and options: the property links must not collide
    let second = record(None, "echo second");

    store.save(&first).unwrap();
    store.save(&second).unwrap();
    let consistency = store.verify_consistency();
    assert!(consistency.errors.is_empty(), "{:?}", consistency.errors);
    assert_eq!(consistency.links_count, 2);

    first.complete(3);
    store.save(&first).unwrap();
    let links = all_links(&store);
    let (a, b) = (&first.uuid, &second.uuid);
    assert!(
        links.contains(&format!("{a}.status: {a} status=executed")),
        "{links}"
    );
    assert!(!links.contains(&format!("{a}.status: {a} status=executing")));
    assert!(links.contains(&format!("{b}.status: {b} status=executing")));
    assert!(links.contains(&format!("{a}.exitCode: {a} exitCode=3")));

    assert!(store.delete(a).unwrap());
    let consistency = store.verify_consistency();
    assert!(consistency.errors.is_empty(), "{:?}", consistency.errors);
    assert_eq!(consistency.links_count, 1);
    let remaining = all_links(&store);
    assert!(!remaining.contains(&format!("{a}.")));
    assert!(remaining.contains(&format!("{b}.command")));
}

fn store_with_fixture(name: &str) -> (tempfile::TempDir, ExecutionStore) {
    let (dir, store) = make_store(false);
    std::fs::copy(
        format!("{}/../js/test/fixtures/{name}", env!("CARGO_MANIFEST_DIR")),
        dir.path().join("executions.lino"),
    )
    .unwrap();
    (dir, store)
}

#[test]
fn reads_a_store_written_by_lino_objects_codec_0_4_and_rewrites_it_readable() {
    // lino-objects-codec 0.9 writes readable links notation; stores of every
    // earlier start-command release are base64 `(str ...)` terms.
    let (dir, store) = store_with_fixture("executions-lino-objects-codec-0.4.0.lino");
    let uuid = "25300000-0000-4000-8000-000000000253";
    let legacy = store.get(uuid).expect("legacy record");
    assert_eq!(legacy.pid, Some(4242));
    assert_eq!(legacy.exit_code, Some(0));
    assert_eq!(legacy.command, "echo \"legacy store\"");

    store.save(&record(None, "echo next")).unwrap();
    let content = std::fs::read_to_string(dir.path().join("executions.lino")).unwrap();
    assert!(content.contains("command \"echo next\""), "{content}");
    assert!(!content.contains("(str "), "{content}");
    assert_eq!(store.get(uuid).unwrap().command, "echo \"legacy store\"");
}

#[test]
fn reads_a_readable_store_written_by_the_javascript_implementation() {
    let (_dir, store) = store_with_fixture("executions-lino-objects-codec-0.9.3.lino");
    let record = store
        .get("25300000-0000-4000-8000-000000000930")
        .expect("record written by JavaScript");
    assert_eq!(record.pid, Some(4242));
    assert_eq!(record.exit_code, Some(0));
    assert_eq!(
        record.command,
        "echo \"readable store\" (with) \\ odd chars 'q' 世界"
    );
    assert_eq!(record.end_time.as_deref(), Some("2026-10-01T00:00:01.000Z"));
    assert_eq!(
        serde_json::Value::Object(record.options.into_iter().collect()),
        serde_json::json!({
            "isolated": "docker",
            "keepAlive": false,
            "nested": { "list": [1, "two", null] }
        })
    );
}
