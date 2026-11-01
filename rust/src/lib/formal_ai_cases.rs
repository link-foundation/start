//! Issue #255: the `--use-formal-ai` task loop against an in-process Formal AI
//! stand-in that replays the receipts captured from the real runtime
//! (js/test/fixtures/formal-ai/receipts.json) plus synthetic failure
//! scenarios. Mirrors js/test/regression-255-loop.js. Real tools run in
//! temporary directories; the only socket is a loopback one.

// Several helpers serve only the tests that need real POSIX tools.
#![cfg_attr(not(unix), allow(dead_code))]

use super::*;
use crate::formal_ai_client::{ClientError, Completion, CompletionClient, HttpClient};
use crate::formal_ai_policy::formal_ai_policy_cases::{populate, receipt_fixture};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::OnceLock;

fn receipts() -> &'static Vec<Value> {
    static RECEIPTS: OnceLock<Vec<Value>> = OnceLock::new();
    RECEIPTS.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../js/test/fixtures/formal-ai/receipts.json"
        );
        let text = fs::read_to_string(path).expect("receipts.json is readable");
        let parsed: Value = serde_json::from_str(&text).expect("receipts.json is JSON");
        parsed["receipts"]
            .as_array()
            .cloned()
            .expect("receipts list")
    })
}

fn tool_call(command: &str) -> Value {
    json!({
        "role": "assistant",
        "content": "Let me run the requested command to get that for you.",
        "tool_calls": [{
            "id": "call_fake",
            "type": "function",
            "function": {
                "name": "bash",
                "arguments": json!({ "command": command }).to_string(),
            },
        }],
    })
}

fn answer(content: &str) -> Value {
    json!({ "role": "assistant", "content": content })
}

/// A reply of the stand-in: a message, or an HTTP error status.
enum Reply {
    Message(Value),
    Status(u16),
}

/// Same replies as js/test/fixtures/formal-ai/replay.cjs.
fn reply(messages: &[Value]) -> Reply {
    let request = messages
        .iter()
        .find(|m| m["role"] == "user")
        .and_then(|m| m["content"].as_str())
        .unwrap_or("");
    let turns = messages.iter().filter(|m| m["role"] == "assistant").count();
    let first = turns == 0;
    let message = match request {
        "synthetic: loop forever" => tool_call("pwd"),
        "synthetic: call an unknown tool" => json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_x",
                "type": "function",
                "function": { "name": "python", "arguments": "{\"code\":\"1\"}" },
            }],
        }),
        "synthetic: read slowly" if first => tool_call("cat slow.txt"),
        "synthetic: read slowly" => answer("done"),
        "synthetic: run a missing tool" if first => tool_call("tree"),
        "synthetic: run a missing tool" => answer("The `tree` command failed."),
        "synthetic: overwrite without looking" => tool_call("touch README.md"),
        "synthetic: write outside" => tool_call("touch ../escape.txt"),
        "synthetic: server error" => return Reply::Status(500),
        "synthetic: unverified mkdir" if first => tool_call("test ! -e out"),
        "synthetic: unverified mkdir" => tool_call("mkdir out"),
        _ => receipts()
            .iter()
            .find(|r| r["request"] == request)
            .map(|r| r["responses"][turns]["message"].clone())
            .filter(|m| !m.is_null())
            .unwrap_or_else(|| {
                json!({
                    "role": "assistant",
                    "content": "I didn't understand you. Could you rephrase?",
                    "thinking_steps": [{ "step": "dispatch_handler", "detail": "unknown" }],
                })
            }),
    };
    Reply::Message(message)
}

/// Serve one HTTP exchange of the agent-mode subset start uses.
fn serve(mut stream: TcpStream) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut head_end = None;
    let mut length = 0;
    loop {
        if let Some(end) = head_end {
            if buf.len() >= end + length {
                break;
            }
        }
        let n = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        if head_end.is_none() {
            if let Some(index) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..index]).to_string();
                length = head
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                head_end = Some(index + 4);
            }
        }
    }
    let end = head_end.unwrap_or(0);
    let first = String::from_utf8_lossy(&buf[..end])
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let (status, payload) = if first.starts_with("GET ") && first.contains("/models ") {
        (
            200,
            json!({ "object": "list", "data": [{ "id": "formal-ai" }] }),
        )
    } else if first.starts_with("POST ") && first.contains("/chat/completions ") {
        let body: Value = serde_json::from_slice(&buf[end..end + length]).unwrap_or(Value::Null);
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        match reply(&messages) {
            Reply::Status(code) => (code, json!({ "error": "synthetic failure" })),
            Reply::Message(message) => {
                let finish = if message.get("tool_calls").is_some() {
                    "tool_calls"
                } else {
                    "stop"
                };
                let payload = json!({
                    "id": "chatcmpl_fake",
                    "object": "chat.completion",
                    "model": "formal-ai",
                    "choices": [{ "index": 0, "message": message, "finish_reason": finish }],
                });
                (200, payload)
            }
        }
    } else {
        (404, json!({ "error": "not found" }))
    };
    let text = payload.to_string();
    let response = format!(
        "HTTP/1.1 {} Fake\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        text.len(),
        text
    );
    let _ = stream.write_all(response.as_bytes());
}

/// Base URL of the shared loopback stand-in.
fn server_url() -> &'static str {
    static URL: OnceLock<String> = OnceLock::new();
    URL.get_or_init(|| {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || serve(stream));
            }
        });
        url
    })
}

/// The real HTTP client, recording every conversation it sends.
struct Recording {
    inner: HttpClient,
    sent: Vec<Vec<Value>>,
}

impl CompletionClient for Recording {
    fn complete(
        &mut self,
        messages: &[Value],
        cancel: &dyn Fn() -> bool,
    ) -> Result<Completion, ClientError> {
        self.sent.push(messages.to_vec());
        self.inner.complete(messages, cancel)
    }

    fn requests(&self) -> u64 {
        self.inner.requests()
    }
}

/// Independent snapshot of a tree (type, size, content and mtime of every
/// entry), read with plain fs calls rather than the policy fingerprint.
fn snapshot(dir: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, relative: &Path, out: &mut BTreeMap<String, String>) {
        for entry in fs::read_dir(root.join(relative)).unwrap().flatten() {
            let child = relative.join(entry.file_name());
            let meta = fs::symlink_metadata(root.join(&child)).unwrap();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            let key = child.to_string_lossy().to_string();
            if meta.is_dir() {
                out.insert(key, format!("dir {}", mtime));
                walk(root, &child, out);
            } else {
                let content = fs::read(root.join(&child)).unwrap_or_default();
                out.insert(
                    key,
                    format!(
                        "file {} {} {}",
                        meta.len(),
                        String::from_utf8_lossy(&content),
                        mtime
                    ),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, Path::new(""), &mut out);
    out
}

#[cfg(unix)]
fn fake_bin(scripts: &[(&str, &str)]) -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    for (name, body) in scripts {
        let path = dir.path().join(name);
        fs::write(&path, format!("#!/bin/sh\n{}\n", body)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    dir
}

#[cfg(unix)]
fn path_first(bin: &Path) -> Vec<(String, String)> {
    let path = std::env::var("PATH").unwrap_or_default();
    vec![("PATH".to_string(), format!("{}:{}", bin.display(), path))]
}

#[derive(Default)]
struct Opts<'a> {
    cwd: Option<&'a Path>,
    effects: Option<&'a str>,
    max_steps: Option<u64>,
    max_retries: Option<u64>,
    max_output_bytes: Option<u64>,
    tool_timeout_ms: Option<u64>,
    env: Vec<(String, String)>,
    expired: bool,
    /// Cancel with this exit status 100 ms after this note.
    cancel_on_note: Option<(&'a str, i32)>,
}

struct Run {
    _fixture: Option<tempfile::TempDir>,
    cwd: PathBuf,
    before: BTreeMap<String, String>,
    after: BTreeMap<String, String>,
    outcome: Outcome,
    evidence: Value,
    tools: Vec<Value>,
    stdout: String,
    stderr: String,
    notes: Vec<String>,
    sent: Vec<Vec<Value>>,
    requests: u64,
}

/// Run one request through the real loop and HTTP client.
fn run(request: &str, opts: Opts<'_>) -> Run {
    let fixture = if opts.cwd.is_none() {
        Some(receipt_fixture())
    } else {
        None
    };
    let cwd = match (opts.cwd, &fixture) {
        (Some(cwd), _) => cwd.to_path_buf(),
        (None, Some(fixture)) => fixture.path().to_path_buf(),
        (None, None) => unreachable!(),
    };
    let mut bounds = Bounds::default();
    if let Some(effects) = opts.effects {
        bounds.effects = effects.to_string();
    }
    bounds.max_steps = opts.max_steps.unwrap_or(bounds.max_steps);
    bounds.max_retries = opts.max_retries.unwrap_or(bounds.max_retries);
    bounds.max_output_bytes = opts.max_output_bytes.unwrap_or(bounds.max_output_bytes);
    bounds.tool_timeout_ms = opts.tool_timeout_ms.unwrap_or(bounds.tool_timeout_ms);
    let deadline = if opts.expired {
        Instant::now()
    } else {
        Instant::now() + Duration::from_millis(bounds.timeout_ms)
    };
    let notes = RefCell::new(Vec::new());
    let cancel_at: Cell<Option<Instant>> = Cell::new(None);
    let trigger = opts.cancel_on_note;
    let note = |text: &str| {
        notes.borrow_mut().push(text.to_string());
        if trigger.is_some_and(|(when, _)| when == text) {
            cancel_at.set(Some(Instant::now() + Duration::from_millis(100)));
        }
    };
    let cancel = || match (trigger, cancel_at.get()) {
        (Some((_, code)), Some(at)) if Instant::now() >= at => Some(code),
        _ => None,
    };
    let mut client = Recording {
        inner: HttpClient::new(server_url(), bounds.max_retries, deadline),
        sent: Vec::new(),
    };
    let before = snapshot(&cwd);
    let mut evidence = json!({});
    let outcome = run_formal_ai_task(
        &TaskOptions {
            request,
            cwd: &cwd,
            env: &opts.env,
            bounds: &bounds,
            deadline,
            mirror: false,
            note: &note,
            cancel: &cancel,
        },
        &mut client,
        &mut evidence,
    );
    let after = snapshot(&cwd);
    let tools: Vec<Value> = evidence["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["kind"] == "tool")
        .cloned()
        .collect();
    let joined = |key: &str| {
        tools
            .iter()
            .map(|t| t[key].as_str().unwrap_or("").to_string())
            .collect::<String>()
    };
    let stdout = joined("stdout");
    let stderr = joined("stderr");
    let requests = client.requests();
    Run {
        _fixture: fixture,
        cwd,
        before,
        after,
        outcome,
        evidence,
        tools,
        stdout,
        stderr,
        notes: notes.into_inner(),
        sent: client.sent,
        requests,
    }
}

fn sorted_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    lines.sort();
    lines
}

fn tool_message(sent: &[Value]) -> String {
    sent.iter()
        .find(|m| m["role"] == "tool")
        .and_then(|m| m["content"].as_str())
        .expect("a tool message was sent")
        .to_string()
}

/// A captured status, allowing for BSD `ls` (exit 1 where GNU exits 2).
fn same_status(expected: &Value, actual: &Value) -> bool {
    expected == actual || (expected == &json!(2) && actual.as_i64().is_some_and(|code| code != 0))
}

#[cfg(unix)]
#[test]
fn every_captured_request_replays_to_its_captured_outcome() {
    for receipt in receipts() {
        let request = receipt["request"].as_str().unwrap();
        let effects = receipt["effects"].as_str().unwrap();
        let result = run(
            request,
            Opts {
                effects: Some(effects),
                ..Opts::default()
            },
        );
        assert_eq!(
            result.outcome.status, receipt["outcome"]["status"],
            "{}",
            request
        );
        assert!(
            same_status(
                &receipt["outcome"]["exitCode"],
                &json!(result.outcome.exit_code)
            ),
            "{}: {:?}",
            request,
            result.outcome
        );
        let expected = receipt["tools"].as_array().unwrap();
        assert_eq!(result.tools.len(), expected.len(), "{}", request);
        for (tool, want) in result.tools.iter().zip(expected) {
            assert_eq!(tool["command"], want["command"], "{}", request);
            assert_eq!(tool["decision"], want["decision"], "{}", request);
            assert!(
                same_status(&want["exitCode"], &tool["exitCode"]),
                "{}: {}",
                request,
                tool
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn lists_a_directory_for_paraphrased_requests_without_changing_it() {
    for request in [
        "print list of files in current directory",
        "what files are in this folder?",
        "ls -la",
    ] {
        let result = run(request, Opts::default());
        assert_eq!(result.outcome.status, "completed", "{}", request);
        assert_eq!(result.outcome.exit_code, 0);
        assert!(result.outcome.message.contains("no file changed"));
        assert!(result.outcome.remaining.is_empty());
        for entry in fs::read_dir(&result.cwd).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(result.stdout.contains(&name), "{} lacks {}", request, name);
        }
        assert_eq!(result.after, result.before);
        assert_eq!(result.evidence["request"], request);
        assert_eq!(result.evidence["effectsMode"], "read-only");
        assert_eq!(result.evidence["steps"][0]["kind"], "response");
        assert_eq!(result.evidence["outcome"]["exitCode"], 0);
    }
}

#[cfg(unix)]
#[test]
fn lists_a_novel_directory_matching_an_independent_listing() {
    let dir = tempfile::tempdir().unwrap();
    populate(
        dir.path(),
        &[
            ("Ωmega file.txt", Some("x")),
            ("日本語 ノート.md", Some("y")),
            ("two  spaces", None),
            ("-dash-first", Some("z")),
            ("émoji 🎉.txt", Some("")),
        ],
    );
    let result = run(
        "print list of files in current directory",
        Opts {
            cwd: Some(dir.path()),
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.exit_code, 0);
    assert_eq!(result.tools.len(), 1);
    assert_eq!(result.tools[0]["argv"], json!(["ls"]));
    // Independent comparison: the tool's real output against read_dir.
    let mut names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    assert_eq!(sorted_lines(&result.stdout), names);
    // Formal AI received exactly that output as untrusted data.
    let content = tool_message(&result.sent[1]);
    assert!(content.contains("<untrusted_context>"));
    assert!(content.contains("日本語 ノート.md"));
    assert_eq!(result.after, result.before);
}

#[cfg(unix)]
#[test]
fn lists_a_named_subdirectory() {
    let result = run("list files in docs", Opts::default());
    assert_eq!(result.outcome.exit_code, 0);
    assert_eq!(result.stdout, "guide.md\n");
}

#[cfg(unix)]
#[test]
fn reports_a_missing_path_with_the_real_tool_status() {
    for request in [
        "list files in missing-dir",
        // Formal AI 0.355.27 reads "corrent" as a path (reported upstream);
        // start reports that truthfully instead of guessing.
        "print list of files in corrent directory",
    ] {
        let result = run(request, Opts::default());
        let code = result.tools[0]["exitCode"].as_i64().unwrap() as i32;
        assert_ne!(code, 0);
        assert_eq!(result.outcome.status, "completed");
        assert_eq!(result.outcome.exit_code, code);
        assert!(result
            .outcome
            .message
            .contains(&format!("exited with {}", code)));
        assert_eq!(result.outcome.remaining, vec!["the last tool call failed"]);
        assert!(result.stderr.contains("No such file or directory"));
        assert_eq!(result.after, result.before);
    }
}

#[cfg(unix)]
#[test]
fn keeps_malicious_file_contents_as_data() {
    let result = run("show contents of notes.txt", Opts::default());
    assert_eq!(result.outcome.exit_code, 0);
    assert_eq!(result.tools[0]["command"], "cat notes.txt");
    assert_eq!(result.tools.len(), 1);
    assert_eq!(result.after, result.before);
    let content = tool_message(&result.sent[1]);
    assert_eq!(content.matches("<untrusted_context>").count(), 1);
    assert_eq!(content.matches("</untrusted_context>").count(), 1);
    assert!(content.contains("[tag removed]"));
}

#[cfg(unix)]
#[test]
fn never_presents_a_read_as_a_completed_deletion() {
    // Formal AI 0.355.27 answers "delete all files" with `ls` and claims
    // success (reported upstream); start reports what really happened.
    let result = run("delete all files", Opts::default());
    assert_eq!(result.tools.len(), 1);
    assert_eq!(result.tools[0]["command"], "ls");
    assert_eq!(
        result.outcome.message,
        "finished after 1 tool call(s); no file changed"
    );
    assert_eq!(result.after, result.before);
}

#[cfg(unix)]
#[test]
fn caps_tool_output() {
    let result = run(
        "print list of files in current directory",
        Opts {
            max_output_bytes: Some(8),
            ..Opts::default()
        },
    );
    assert!(result.stdout.len() <= 8, "{:?}", result.stdout);
    assert_eq!(result.tools[0]["truncated"], true);
    assert!(result
        .notes
        .join("\n")
        .contains("output truncated at START_FORMAL_AI_MAX_OUTPUT_BYTES=8"));
    let last = result.sent[1].last().unwrap()["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(last.contains("[output truncated by start]"));
}

#[test]
fn fails_explicitly_when_formal_ai_does_not_understand() {
    for request in ["book me a flight to Paris", "an request nobody recorded"] {
        let result = run(request, Opts::default());
        assert_eq!(result.outcome.status, "unsupported");
        assert_eq!(result.outcome.exit_code, EXIT_UNSUPPORTED);
        assert!(result.tools.is_empty());
        assert_eq!(result.after, result.before);
    }
}

#[test]
fn refuses_shell_syntax_formal_ai_passes_through() {
    let result = run("ls; rm -rf ~", Opts::default());
    assert_eq!(result.outcome.status, "refused");
    assert_eq!(result.outcome.exit_code, EXIT_REFUSED);
    assert_eq!(result.tools.len(), 1);
    assert_eq!(result.tools[0]["command"], "ls; rm -rf ~");
    assert_eq!(result.tools[0]["decision"], "refused");
    assert!(result.tools[0].get("exitCode").is_none());
    assert_eq!(result.after, result.before);
}

#[cfg(unix)]
#[test]
fn refuses_changes_in_read_only_mode() {
    let result = run("create a directory named build", Opts::default());
    assert_eq!(result.outcome.exit_code, EXIT_REFUSED);
    assert!(result.outcome.message.contains("effect mode is read-only"));
    let calls: Vec<(String, String)> = result
        .tools
        .iter()
        .map(|t| {
            (
                t["command"].as_str().unwrap().to_string(),
                t["decision"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        calls,
        vec![
            ("test ! -e build".to_string(), "allowed".to_string()),
            ("mkdir build".to_string(), "refused".to_string()),
        ]
    );
    assert!(!result.cwd.join("build").exists());
    assert_eq!(result.after, result.before);
}

#[test]
fn refuses_a_change_to_a_target_it_never_observed() {
    let result = run(
        "synthetic: overwrite without looking",
        Opts {
            effects: Some("workspace-write"),
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.exit_code, EXIT_REFUSED);
    assert!(result.outcome.message.contains("was not observed"));
    assert_eq!(result.after, result.before);
}

#[test]
fn refuses_a_change_outside_the_working_directory() {
    let result = run(
        "synthetic: write outside",
        Opts {
            effects: Some("workspace-write"),
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.exit_code, EXIT_REFUSED);
    assert!(result
        .outcome
        .message
        .contains("outside the working directory"));
    assert!(!result.cwd.join("..").join("escape.txt").exists());
}

#[test]
fn rejects_a_tool_start_does_not_offer() {
    let result = run("synthetic: call an unknown tool", Opts::default());
    assert_eq!(result.outcome.status, "protocol-error");
    assert_eq!(result.outcome.exit_code, EXIT_PROTOCOL);
    assert!(result.tools.is_empty());
}

#[test]
fn reports_a_failing_runtime_after_bounded_retries() {
    let result = run(
        "synthetic: server error",
        Opts {
            max_retries: Some(2),
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.status, "protocol-error");
    assert_eq!(result.outcome.exit_code, EXIT_PROTOCOL);
    assert_eq!(
        result.outcome.message,
        "Formal AI returned HTTP 500 (after 2 retries)"
    );
    assert_eq!(result.requests, 3);
    assert_eq!(
        result.outcome.remaining,
        vec!["Formal AI did not complete the task"]
    );
}

#[cfg(unix)]
#[test]
fn observes_changes_and_reads_back_in_workspace_write_mode() {
    let result = run(
        "create a directory named build",
        Opts {
            effects: Some("workspace-write"),
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.status, "completed");
    assert_eq!(result.outcome.exit_code, 0);
    assert_eq!(
        result.outcome.message,
        "finished after 3 tool call(s); added build"
    );
    let mkdir = result
        .tools
        .iter()
        .find(|t| t["command"] == "mkdir build")
        .unwrap();
    assert_eq!(mkdir["effect"], "write");
    assert_eq!(
        mkdir["verification"],
        json!({ "verified": true, "detail": "readback confirmed mkdir build" })
    );
    assert!(result.cwd.join("build").is_dir());
    // Unrelated content is untouched.
    let mut rest = result.after.clone();
    assert!(rest.remove("build").is_some());
    assert_eq!(
        rest.keys().collect::<Vec<_>>(),
        result.before.keys().collect::<Vec<_>>()
    );
    for (name, value) in &result.before {
        if !value.starts_with("dir") {
            assert_eq!(&rest[name], value, "{}", name);
        }
    }
}

#[cfg(unix)]
#[test]
fn does_not_trust_an_exit_status_the_readback_contradicts() {
    let bin = fake_bin(&[("mkdir", "exit 0")]);
    let result = run(
        "synthetic: unverified mkdir",
        Opts {
            effects: Some("workspace-write"),
            env: path_first(bin.path()),
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.status, "unverified");
    assert_eq!(result.outcome.exit_code, EXIT_PROTOCOL);
    assert!(result.outcome.message.contains("readback failed: out"));
}

#[cfg(unix)]
#[test]
fn reports_a_missing_tool_as_127() {
    let bin = fake_bin(&[]);
    let result = run(
        "synthetic: run a missing tool",
        Opts {
            env: vec![("PATH".to_string(), bin.path().display().to_string())],
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.exit_code, 127);
    assert_eq!(result.tools[0]["exitCode"], 127);
    assert_eq!(result.tools[0]["spawnError"], "ENOENT");
}

#[test]
fn stops_at_the_step_budget() {
    let result = run(
        "synthetic: loop forever",
        Opts {
            max_steps: Some(3),
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.status, "budget-exhausted");
    assert_eq!(result.outcome.exit_code, EXIT_BUDGET);
    assert_eq!(result.tools.len(), 3);
}

#[test]
fn stops_at_the_time_budget() {
    let result = run(
        "print list of files in current directory",
        Opts {
            expired: true,
            ..Opts::default()
        },
    );
    assert_eq!(result.outcome.exit_code, EXIT_BUDGET);
    assert!(result.tools.is_empty());
    assert_eq!(result.requests, 0);
}

#[cfg(unix)]
#[test]
fn stops_a_tool_at_its_time_limit() {
    let bin = fake_bin(&[("cat", "exec sleep 30")]);
    let started = Instant::now();
    let result = run(
        "synthetic: read slowly",
        Opts {
            tool_timeout_ms: Some(300),
            env: path_first(bin.path()),
            ..Opts::default()
        },
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(result.outcome.status, "budget-exhausted");
    assert_eq!(result.outcome.exit_code, EXIT_BUDGET);
    assert_eq!(result.tools[0]["timedOut"], true);
}

#[cfg(unix)]
#[test]
fn cancels_the_running_tool_and_reports_the_signal() {
    let bin = fake_bin(&[("cat", "exec sleep 30")]);
    for (name, code) in [("SIGTERM", 143), ("SIGINT", 130)] {
        let started = Instant::now();
        let result = run(
            "synthetic: read slowly",
            Opts {
                env: path_first(bin.path()),
                cancel_on_note: Some(("$ cat slow.txt", code)),
                ..Opts::default()
            },
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(result.outcome.status, "cancelled");
        assert_eq!(result.outcome.exit_code, code);
        assert_eq!(result.outcome.message, format!("cancelled by {}", name));
        assert_eq!(
            result.outcome.remaining,
            vec!["the task was interrupted; later steps did not run"]
        );
    }
}

#[test]
fn maps_signal_names_to_exit_statuses() {
    assert_eq!(signal_exit("SIGINT"), 130);
    assert_eq!(signal_exit("SIGTERM"), 143);
    assert_eq!(signal_exit("SIGHUP"), 129);
    let long = "x".repeat(PREVIEW_CHARS + 5);
    assert!(preview(&long).ends_with("… [5 more chars]"));
}
