//! Issue #231: executions get caller-chosen names (`--alias`, `--rename`) and
//! can declare the execution they continue (`--continues`), which `--status`
//! reports and `--upload-log` follows. Mirrors js/test/regression-231.js.

#![cfg(unix)]

use serde_json::{json, Value};
use start_command::args_parser::parse_args;
use start_command::execution_chain::{
    build_chain, identity_text_lines, prepare_chain_upload, resolve_continues, status_identity,
};
use start_command::execution_identity::{execution_aliases, find_record, name_execution};
use start_command::execution_store::{
    is_clink_installed, ExecutionRecord, ExecutionRecordOptions, ExecutionStore,
    ExecutionStoreOptions,
};
use std::collections::HashMap;
use std::fs;
use std::process::{Command, Output, Stdio};

const A: &str = "23100000-0000-4000-8000-00000000000a";
const B: &str = "23100000-0000-4000-8000-00000000000b";
const C: &str = "23100000-0000-4000-8000-00000000000c";

struct Sandbox {
    root: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        Sandbox {
            root: tempfile::tempdir().unwrap(),
        }
    }

    fn store(&self) -> ExecutionStore {
        ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(self.root.path().join("app")),
            use_links: Some(false),
            verbose: false,
        })
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_start"))
            .args(args)
            .env("START_APP_FOLDER", self.root.path().join("app"))
            .env("START_LOG_DIR", self.root.path().join("logs"))
            .env("START_DISABLE_AUTO_ISSUE", "1")
            .env("START_DISABLE_LOG_UPLOAD", "1")
            .env_remove("START_EXECUTION_ID")
            .env_remove("START_ATTEMPT")
            .stdin(Stdio::null())
            .output()
            .expect("failed to run the start binary")
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).to_string()
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn record(uuid: &str, options: Value) -> ExecutionRecord {
    let options: HashMap<String, Value> = serde_json::from_value(options).unwrap();
    ExecutionRecord::with_options(ExecutionRecordOptions {
        uuid: Some(uuid.into()),
        command: format!("cmd-{}", uuid),
        options: Some(options),
        ..Default::default()
    })
}

fn chain_records() -> Vec<ExecutionRecord> {
    let mut a = record(A, json!({}));
    a.start_time = "2026-01-01T00:00:00.000Z".into();
    let mut b = record(B, json!({}));
    b.continues = Some(A.into());
    b.start_time = "2026-01-02T00:00:00.000Z".into();
    let mut c = record(C, json!({}));
    c.continues = Some(B.into());
    c.start_time = "2026-01-03T00:00:00.000Z".into();
    vec![a, b, c]
}

fn uuids(records: &[ExecutionRecord]) -> Vec<&str> {
    records.iter().map(|r| r.uuid.as_str()).collect()
}

#[test]
fn resolves_uuid_session_name_earlier_names_then_aliases() {
    let records = vec![
        record(A, json!({ "aliases": [B] })),
        record(B, json!({ "sessionName": "live" })),
        record(C, json!({ "sessionNameHistory": ["old"], "name": "task" })),
    ];
    assert_eq!(find_record(&records, B).unwrap().uuid, B);
    assert_eq!(find_record(&records, "live").unwrap().uuid, B);
    assert_eq!(find_record(&records, "old").unwrap().uuid, C);
    assert_eq!(find_record(&records, "task").unwrap().uuid, C);
    assert!(find_record(&records, "missing").is_none());
    assert!(find_record(&records, "").is_none());
}

#[test]
fn alias_adds_a_name_and_refuses_one_used_by_another_execution() {
    let box_ = Sandbox::new();
    let store = box_.store();
    store
        .save(&record(A, json!({ "sessionName": "screen-a" })))
        .unwrap();
    store.save(&record(B, json!({}))).unwrap();
    assert_eq!(
        name_execution(Some(&store), "screen-a", "task-1", false),
        Ok(format!(
            "Aliased execution {}\naliases: [{}, screen-a, task-1]",
            A, A
        ))
    );
    assert_eq!(store.get("task-1").unwrap().uuid, A);
    assert!(name_execution(Some(&store), A, "task-1", false)
        .unwrap()
        .starts_with(&format!("Unchanged execution {}", A)));
    assert_eq!(
        name_execution(Some(&store), B, "task-1", false),
        Err(format!("Name \"task-1\" already refers to execution {}", A))
    );
    assert!(name_execution(Some(&store), B, A, false).is_err());
    assert_eq!(
        name_execution(Some(&store), "nope", "x", false),
        Err("No execution found with UUID or session name: nope".into())
    );
    assert!(name_execution(Some(&store), A, "-x", false).is_err());
    assert!(name_execution(None, A, "x", false).is_err());
    // The backend session name list is left alone (it drives --cleanup).
    assert!(!store
        .get(A)
        .unwrap()
        .options
        .contains_key("sessionNameHistory"));
}

#[test]
fn rename_sets_the_display_name_and_keeps_the_old_one_resolving() {
    let box_ = Sandbox::new();
    let store = box_.store();
    store
        .save(&record(A, json!({ "sessionName": "screen-a" })))
        .unwrap();
    assert_eq!(
        name_execution(Some(&store), A, "first", true),
        Ok(format!(
            "Renamed execution {}\naliases: [{}, screen-a, first]",
            A, A
        ))
    );
    name_execution(Some(&store), "first", "second", true).unwrap();
    let renamed = store.get("second").unwrap();
    assert_eq!(renamed.options["sessionName"], "screen-a");
    assert_eq!(renamed.options["name"], "second");
    assert_eq!(renamed.options["aliases"], json!(["first"]));
    assert_eq!(store.get("first").unwrap().uuid, A);
    assert_eq!(store.get("screen-a").unwrap().uuid, A);
    assert_eq!(
        execution_aliases(&renamed),
        vec![A, "screen-a", "first", "second"]
    );
}

/// Issue #253: the rename used to reach only the lino store; clink 4.x
/// rejected every links query the store built.
#[test]
fn rename_reaches_the_links_database() {
    if !is_clink_installed() {
        eprintln!("clink not installed; skipping");
        return;
    }
    let box_ = Sandbox::new();
    let store = ExecutionStore::with_options(ExecutionStoreOptions {
        app_folder: Some(box_.root.path().join("app")),
        use_links: Some(true),
        verbose: false,
    });
    store
        .save(&record(A, json!({ "sessionName": "screen-a" })))
        .unwrap();
    name_execution(Some(&store), A, "first", true).unwrap();
    let links = Command::new("clink")
        .arg("((($id: $s $t)) (($id: $s $t)))")
        .arg("--db")
        .arg(store.get_stats().links_db_path)
        .arg("--changes")
        .output()
        .unwrap();
    let links = text(&links.stdout);
    assert!(
        links.contains(&format!("{A}.options: {A} 'options=")),
        "{links}"
    );
    assert!(links.contains("\"name\":\"first\""), "{links}");
    assert!(store.verify_consistency().errors.is_empty());
}

#[test]
fn a_uuid_shaped_alias_resolves_like_any_other_name() {
    let box_ = Sandbox::new();
    let store = box_.store();
    store.save(&record(A, json!({}))).unwrap();
    assert!(name_execution(Some(&store), A, C, false).is_ok());
    assert_eq!(store.get(C).unwrap().uuid, A);
}

#[test]
fn parses_alias_and_rename_with_their_two_arguments() {
    let alias = parse_args(&args(&["--alias", A, "task"])).unwrap();
    assert_eq!(alias.wrapper_options.alias.as_deref(), Some(A));
    assert_eq!(alias.wrapper_options.new_name.as_deref(), Some("task"));
    let rename = parse_args(&args(&["--rename", A, "task"])).unwrap();
    assert_eq!(rename.wrapper_options.rename.as_deref(), Some(A));
    assert_eq!(rename.wrapper_options.new_name.as_deref(), Some("task"));
    assert_eq!(
        parse_args(&args(&["--alias", A])).err().unwrap(),
        "Option --alias requires a UUID or session name and a new name"
    );
    assert_eq!(
        parse_args(&args(&["--rename", A, "--status"]))
            .err()
            .unwrap(),
        "Option --rename requires a UUID or session name and a new name"
    );
    let combined = parse_args(&args(&["--alias", A, "x", "--status", A]))
        .err()
        .unwrap();
    assert!(
        combined.contains("--alias, or --rename in the same invocation"),
        "{}",
        combined
    );
}

#[test]
fn builds_the_chain_from_any_member_oldest_first() {
    let records = chain_records();
    for member in &records {
        assert_eq!(uuids(&build_chain(&records, member)), vec![A, B, C]);
    }
}

#[test]
fn stops_at_a_cycle() {
    let mut a = record(A, json!({}));
    a.continues = Some(B.into());
    let mut b = record(B, json!({}));
    b.continues = Some(A.into());
    let records = vec![a, b];
    assert_eq!(uuids(&build_chain(&records, &records[0])), vec![B, A]);
}

#[test]
fn resolves_continues_by_any_name_and_refuses_unknown_or_itself() {
    let box_ = Sandbox::new();
    let store = box_.store();
    store
        .save(&record(A, json!({ "sessionName": "first" })))
        .unwrap();
    assert_eq!(resolve_continues(Some(&store), "first", B), Ok(A.into()));
    assert_eq!(
        resolve_continues(Some(&store), "nope", B),
        Err("No execution found with UUID or session name: nope".into())
    );
    assert_eq!(
        resolve_continues(Some(&store), A, A),
        Err(format!("Execution {} cannot continue itself", A))
    );
    assert_eq!(
        resolve_continues(None, A, B),
        Err("--continues requires execution tracking.".into())
    );
}

#[test]
fn status_reports_aliases_and_the_chain() {
    let box_ = Sandbox::new();
    let store = box_.store();
    for r in chain_records() {
        store.save(&r).unwrap();
    }
    name_execution(Some(&store), B, "task", false).unwrap();
    let b = store.get(B).unwrap();
    let identity = status_identity(&b, Some(&store));
    let keys: Vec<&str> = identity.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, vec!["aliases", "chain"]);
    assert_eq!(identity[0].1, json!([B, "task"]));
    assert_eq!(identity[1].1, json!([A, B, C]));
    assert_eq!(
        identity_text_lines(&b, &identity),
        vec![
            format!("Aliases:           {}, task", B),
            format!("Continues:         {}", A),
            format!("Chain:             {} -> {} -> {}", A, B, C),
        ]
    );
    // A record without names or a chain is reported unchanged.
    let plain = record("23100000-0000-4000-8000-0000000000dd", json!({}));
    assert!(status_identity(&plain, Some(&store)).is_empty());
    assert!(status_identity(&plain, None).is_empty());
}

#[test]
fn upload_log_joins_the_chain_logs_oldest_first() {
    let box_ = Sandbox::new();
    let store = box_.store();
    for (i, mut r) in chain_records().into_iter().enumerate() {
        let log_path = box_.root.path().join(format!("{}.log", i));
        fs::write(&log_path, format!("log-{}\n", i)).unwrap();
        r.log_path = log_path.to_string_lossy().to_string();
        store.save(&r).unwrap();
    }
    let mut single = record("23100000-0000-4000-8000-0000000000dd", json!({}));
    single.log_path = "/x.log".into();
    store.save(&single).unwrap();
    assert!(prepare_chain_upload(&store, &single).unwrap().is_none());

    let prepared = prepare_chain_upload(&store, &store.get(B).unwrap())
        .unwrap()
        .unwrap();
    let path = prepared.path.clone();
    let log = fs::read_to_string(&path).unwrap();
    assert!(log.find("log-0").unwrap() < log.find("log-1").unwrap());
    assert!(log.find("log-1").unwrap() < log.find("log-2").unwrap());
    assert_eq!(log.matches("\"event\":\"continuation\"").count(), 3);
    assert!(log.contains("\"chainIndex\":3,\"chainLength\":3"));
    assert!(log.contains(&format!("\"uuid\":\"{}\"", C)));
    drop(prepared);
    assert!(!path.exists());
}

#[test]
fn parses_continues_and_keeps_it_to_launches() {
    let parsed = parse_args(&args(&["--continues", A, "--", "echo"])).unwrap();
    assert_eq!(parsed.wrapper_options.continues.as_deref(), Some(A));
    let inline = format!("--continues={}", A);
    let parsed = parse_args(&args(&[&inline, "--", "echo"])).unwrap();
    assert_eq!(parsed.wrapper_options.continues.as_deref(), Some(A));
    assert_eq!(
        parse_args(&args(&["--continues", "--", "echo"]))
            .err()
            .unwrap(),
        "Option --continues requires a UUID or session name argument"
    );
    assert_eq!(
        parse_args(&args(&["--status", A, "--continues", B]))
            .err()
            .unwrap(),
        "--continues option is only valid when launching a command"
    );
}

#[test]
fn aliases_renames_and_chains_executions_end_to_end() {
    let box_ = Sandbox::new();
    let first = box_.run(&["--session-id", A, "--", "echo", "one"]);
    assert_eq!(first.status.code(), Some(0), "{}", text(&first.stderr));
    let alias = box_.run(&["--alias", A, "nightly"]);
    assert_eq!(alias.status.code(), Some(0), "{}", text(&alias.stderr));
    assert!(text(&alias.stdout).contains(&format!("Aliased execution {}", A)));
    let rename = box_.run(&["--rename", "nightly", "nightly-1"]);
    assert!(text(&rename.stdout).contains(&format!("Renamed execution {}", A)));

    let second = box_.run(&[
        "--session-id",
        B,
        "--continues",
        "nightly-1",
        "--",
        "echo",
        "two",
    ]);
    assert_eq!(second.status.code(), Some(0), "{}", text(&second.stderr));

    let status = box_.run(&["--status", "nightly-1", "--output-format", "json"]);
    let obj: Value = serde_json::from_str(&text(&status.stdout)).unwrap();
    assert_eq!(obj["uuid"], A);
    assert_eq!(obj["aliases"], json!([A, "nightly", "nightly-1"]));
    assert_eq!(obj["chain"], json!([A, B]));

    let status_text = box_.run(&["--status", B, "--output-format", "text"]);
    let out = text(&status_text.stdout);
    assert!(
        out.contains(&format!("Continues:         {}", A)),
        "{}",
        out
    );
    assert!(
        out.contains(&format!("Chain:             {} -> {}", A, B)),
        "{}",
        out
    );

    let links = text(&box_.run(&["--status", B]).stdout);
    let chain_block = format!(
        "  uuid {}\n  chain\n    (\n      {}\n      {}\n    )",
        B, A, B
    );
    assert!(links.contains(&chain_block), "{}", links);

    let missing = box_.run(&["--continues", "nope", "--", "echo", "x"]);
    assert_eq!(missing.status.code(), Some(1));
    assert!(text(&missing.stderr).contains("No execution found with UUID or session name: nope"));
    assert!(!text(&missing.stdout).contains("x\n"));
}
