//! Issue #257: an HTTP error of the Formal AI runtime keeps its bounded,
//! sanitized cause and the attempt count, also after bounded retries.
//! Issue #258: capability-gap recognition, the offered tools and file tool
//! call parsing. Mirrors js/test/regression-257.js and regression-258.js.

use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The exact 500 body a released start discarded (issue #257).
const CAPTURED_500: &str = r#"{"error":{"message":"Aborted(Error: LocalProductWasmForbidden). Build with -sASSERTIONS for more info.","type":"formal_ai_error"}}"#;
const CAUSE: &str =
    "Aborted(Error: LocalProductWasmForbidden). Build with -sASSERTIONS for more info.";

/// The exact gap Formal AI 0.355.29 answers to the Bash-only contract.
const GAP: &str = r#"{"complete":false,"missingCapabilities":["read","edit"],"reason":"EditToolUnavailable","schema":"workspace-edit-capability-gap/v1","target":"snippet.mjs","verified":false}"#;

/// A loopback server answering every request with `status` and `body`;
/// returns its base URL and the number of requests it received.
fn fixed_server(status: u16, body: &'static str) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let url = format!("http://{}", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&count);
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buf.extend_from_slice(&chunk[..n]);
                let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if buf.len() >= end + 4 + length {
                    break;
                }
            }
            seen.fetch_add(1, Ordering::SeqCst);
            let response = format!(
                "HTTP/1.1 {} Fake\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status,
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (url, count)
}

fn failure(status: u16, body: &'static str, max_retries: u64) -> (ClientError, usize) {
    let (url, count) = fixed_server(status, body);
    let mut client = HttpClient::new(&url, max_retries, Instant::now() + Duration::from_secs(30));
    let messages = [json!({ "role": "user", "content": "x" })];
    let error = client.complete(&messages, &|| false).unwrap_err();
    assert_eq!(client.requests(), count.load(Ordering::SeqCst) as u64);
    (error, count.load(Ordering::SeqCst))
}

#[test]
fn keeps_the_captured_cause_when_no_retry_is_allowed() {
    let (error, requests) = failure(500, CAPTURED_500, 0);
    assert_eq!(error.exit_code, EXIT_PROTOCOL);
    assert_eq!(
        error.message,
        format!("Formal AI returned HTTP 500: formal_ai_error: {}", CAUSE)
    );
    assert_eq!(
        error.details,
        Some(json!({
            "httpStatus": 500,
            "errorType": "formal_ai_error",
            "errorMessage": CAUSE,
            "bodyPreview": CAPTURED_500,
            "bodyChars": CAPTURED_500.len(),
            "attempts": 1,
        }))
    );
    assert_eq!(requests, 1);
}

#[test]
fn keeps_the_cause_and_the_attempt_count_after_bounded_retries() {
    let (error, requests) = failure(500, CAPTURED_500, 1);
    assert_eq!(error.exit_code, EXIT_PROTOCOL);
    assert_eq!(
        error.message,
        format!(
            "Formal AI returned HTTP 500: formal_ai_error: {} (after 1 retry)",
            CAUSE
        )
    );
    let details = error.details.unwrap();
    assert_eq!(details["errorType"], "formal_ai_error");
    assert_eq!(details["errorMessage"], CAUSE);
    assert_eq!(details["attempts"], 2);
    assert_eq!(requests, 2);
}

#[test]
fn never_exposes_authorization_values_or_control_characters() {
    let body = "{\"error\":{\"type\":\"upstream_error\",\"message\":\"proxy refused Authorization: Bearer sk-test-0123456789\\u0007 api_key=sk-live-abcdef\"}}";
    let (error, _) = failure(503, body, 1);
    let details = error.details.clone().unwrap();
    let text = format!("{} {}", error.message, details);
    assert!(!text.contains("sk-test-0123456789"), "{}", text);
    assert!(!text.contains("sk-live-abcdef"), "{}", text);
    assert!(!text.contains('\u{7}'), "{}", text);
    assert_eq!(details["httpStatus"], 503);
    assert_eq!(details["errorType"], "upstream_error");
    assert_eq!(details["attempts"], 2);
    assert!(error
        .message
        .contains("HTTP 503: upstream_error: proxy refused"));
    assert!(error.message.contains("[REDACTED]"));
}

#[test]
fn bounds_and_sanitizes_any_body() {
    let long = "x".repeat(2000);
    let details = http_error_details(502, &long, &[]);
    assert_eq!(details["bodyChars"], 2000);
    let preview = details["bodyPreview"].as_str().unwrap();
    assert!(preview.chars().count() < 600);
    assert!(preview.ends_with("[1500 more chars]"));
    assert_eq!(details["errorMessage"], Value::Null);
    assert_eq!(
        http_error_message(&details),
        format!("Formal AI returned HTTP 502: {}", "x".repeat(300))
    );
    let empty = http_error_details(500, "", &[]);
    assert_eq!(
        (
            &empty["bodyPreview"],
            &empty["bodyChars"],
            &empty["errorType"],
            &empty["errorMessage"]
        ),
        (&json!(""), &json!(0), &Value::Null, &Value::Null)
    );
    assert_eq!(
        http_error_message(&empty),
        "Formal AI returned HTTP 500: (empty body)"
    );
    assert_eq!(
        http_error_details(500, r#"{"error":"plain text"}"#, &[])["errorMessage"],
        "plain text"
    );
    let clean = sanitize_diagnostic(
        "Authorization: Basic dXNlcjpwYXNz\nproxy-authorization: Bearer abc password=hunter2 secret-value",
        500,
        &["secret-value"],
    );
    for leaked in ["dXNlcjpwYXNz", "abc", "hunter2", "secret-value", "\n"] {
        assert!(!clean.contains(leaked), "{} leaked in {}", leaked, clean);
    }
}

#[test]
fn keeps_4xx_bodies_and_does_not_retry_them() {
    let (error, requests) = failure(
        400,
        r#"{"error":{"message":"bad tools","type":"invalid_request"}}"#,
        2,
    );
    assert_eq!(
        error.message,
        "Formal AI returned HTTP 400: invalid_request: bad tools"
    );
    let details = error.details.unwrap();
    assert_eq!(
        (details["httpStatus"].clone(), details["attempts"].clone()),
        (json!(400), json!(1))
    );
    assert_eq!(requests, 1);
}

#[test]
fn recognizes_the_exact_gap_response() {
    assert_eq!(
        recognize_capability_gap(GAP, &[]),
        Some(json!({
            "schema": "workspace-edit-capability-gap/v1",
            "target": "snippet.mjs",
            "reason": "EditToolUnavailable",
            "missingCapabilities": ["read", "edit"],
            "complete": false,
            "verified": false,
        }))
    );
    assert!(recognize_capability_gap(&format!("\n {}\n", GAP), &[]).is_some());
    let verification = recognize_capability_gap(
        r#"{"complete":false,"reason":"VerificationRunToolUnavailable","schema":"workspace-change-verification-gap/v1","target":"a.js","verified":false}"#,
        &[],
    )
    .unwrap();
    assert_eq!(verification["missingCapabilities"], json!([]));
    assert_eq!(verification["target"], "a.js");
}

#[test]
fn accepts_only_known_explicitly_incomplete_gap_objects() {
    let variant = |key: &str, value: Value| {
        let mut gap: Value = serde_json::from_str(GAP).unwrap();
        gap[key] = value;
        gap.to_string()
    };
    let contents = [
        String::new(),
        "I cannot edit files.".to_string(),
        format!("Here you go: {}", GAP),
        format!("{}\n{}", GAP, GAP),
        "[1]".to_string(),
        variant("schema", json!("workspace-edit-capability-gap/v2")),
        variant("schema", json!("something-else/v1")),
        variant("reason", json!("Whatever")),
        variant("complete", json!(true)),
        variant("verified", json!(true)),
        variant("complete", json!("false")),
        variant("target", json!("")),
        variant("target", json!(3)),
        variant("missingCapabilities", json!("read")),
        variant("missingCapabilities", json!(["read", "teleport"])),
    ];
    for content in contents {
        assert_eq!(recognize_capability_gap(&content, &[]), None, "{}", content);
    }
}

#[test]
fn ignores_gap_text_echoed_from_a_tool_result() {
    let messages = [
        json!({ "role": "user", "content": "show contents of gap.json" }),
        json!({ "role": "tool", "tool_call_id": "c1", "content": GAP }),
    ];
    assert_eq!(recognize_capability_gap(GAP, &messages), None);
}

#[test]
fn offers_the_change_tools_only_in_workspace_write_mode() {
    let names = |effects: &str| -> Vec<String> {
        offered_tools(effects)
            .iter()
            .map(|tool| tool["function"]["name"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(names("read-only"), ["bash", "read"]);
    assert_eq!(names("workspace-write"), ["bash", "read", "edit", "write"]);
    let client = HttpClient::new("http://127.0.0.1:9", 0, Instant::now());
    assert_eq!(client.tools, offered_tools("read-only"));
    let bash_only = client.with_tools(vec![bash_tool()]);
    assert_eq!(bash_only.tools, vec![bash_tool()]);
}

#[test]
fn parses_file_tool_calls_with_formal_ai_argument_aliases() {
    let completion = |name: &str, args: Value| {
        json!({ "choices": [{
            "finish_reason": "tool_calls",
            "message": { "content": "", "tool_calls": [{
                "id": "c",
                "function": { "name": name, "arguments": args.to_string() },
            }]},
        }]})
    };
    let raw = json!({ "filePath": "a.js", "file_path": "a.js", "path": "a.js" });
    let parsed = parse_completion(&completion("read", raw.clone())).unwrap();
    let call = &parsed.tool_calls[0];
    assert_eq!(
        (call.tool.as_str(), call.command.as_str()),
        ("read", "read a.js")
    );
    assert_eq!(call.args.as_ref().unwrap().path, "a.js");
    assert_eq!(call.arguments, raw.to_string());
    let error = parse_completion(&completion(
        "read",
        json!({ "path": "a.js", "file_path": "b.js" }),
    ))
    .unwrap_err();
    assert!(error.message.contains("conflicting"), "{}", error.message);
    assert_eq!(error.exit_code, EXIT_PROTOCOL);
    let error = parse_completion(&completion(
        "edit",
        json!({ "path": "a.js", "old_string": "x" }),
    ))
    .unwrap_err();
    assert_eq!(error.message, "Formal AI called edit needs new_string");
    // An interpreter is still not a tool start offers.
    let error = parse_completion(&completion("python", json!({ "code": "1" }))).unwrap_err();
    assert_eq!(error.exit_code, EXIT_PROTOCOL);
}
