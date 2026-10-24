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
