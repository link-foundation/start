//! Minimal client of the OpenAI-compatible agent-mode endpoint of Formal AI
//! (`POST /api/openai/v1/chat/completions`), used by `--use-formal-ai`
//! (issue #255). Mirrors js/src/lib/formal-ai-client.js. It offers the
//! `bash` tool and the structured `read` tool, plus `edit` and `write` when
//! workspace changes are allowed (issue #258): Formal AI picks the call, start
//! decides whether and how it runs.
//!
//! An HTTP error keeps a bounded, sanitized excerpt of its body (the error
//! type, message and a preview) and the attempt count, so a failing runtime
//! names its cause (issue #257).
//!
//! The runtime is always a loopback `http://` server, so a small blocking
//! HTTP/1.1 client over `std::net` is enough; it polls for cancellation and
//! the time budget while it waits.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{json, Value};

use crate::formal_ai_files::{describe_file_call, file_tool, normalize_file_args, FileArgs};
use crate::formal_ai_policy::{EXIT_BUDGET, EXIT_PROTOCOL, EXIT_UNAVAILABLE};

pub const API_PREFIX: &str = "/api/openai/v1";
/// Names Formal AI may use for the bash tool.
pub const BASH_NAMES: [&str; 3] = ["bash", "shell", "run_command"];
/// Every tool name start accepts.
pub const TOOL_NAMES: [&str; 6] = ["bash", "shell", "run_command", "read", "edit", "write"];
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const POLL: Duration = Duration::from_millis(100);

/// The bash tool offered to Formal AI.
pub fn bash_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run one command in the working directory. Pipes, redirects, globs and variables are not supported.",
            "parameters": {
                "type": "object",
                "properties": { "command": { "type": "string" } },
                "required": ["command"],
            },
        },
    })
}

/// Tools offered to Formal AI: the change tools only when the effect mode
/// allows changes, so the advertised contract matches the policy.
pub fn offered_tools(effects: &str) -> Vec<Value> {
    let names: &[&str] = if effects == "workspace-write" {
        &["read", "edit", "write"]
    } else {
        &["read"]
    };
    std::iter::once(bash_tool())
        .chain(names.iter().map(|name| file_tool(name)))
        .collect()
}

/// A failed exchange with Formal AI and the exit status it maps to.
#[derive(Debug, Clone, PartialEq)]
pub struct ClientError {
    pub message: String,
    pub exit_code: i32,
    pub cancelled: bool,
    /// Sanitized, bounded diagnostics (HTTP status, error type and message,
    /// body preview, attempts) the evidence keeps (issue #257).
    pub details: Option<Value>,
}

impl ClientError {
    pub fn protocol(message: impl Into<String>) -> Self {
        Self::with_code(message, EXIT_PROTOCOL)
    }

    pub fn with_code(message: impl Into<String>, exit_code: i32) -> Self {
        Self {
            message: message.into(),
            exit_code,
            cancelled: false,
            details: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

const PREVIEW_CHARS: usize = 500;
const MESSAGE_CHARS: usize = 300;
const REDACTED: &str = "[REDACTED]";

fn sanitizers() -> &'static [(Regex, &'static str); 4] {
    static PATTERNS: std::sync::OnceLock<[(Regex, &'static str); 4]> = std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        let compile = |pattern: &str| Regex::new(pattern).expect("valid sanitizer pattern");
        [
            (
                compile(r#"(?i)((?:proxy-)?authorization["']?\s*[:=]\s*["']?)[^"'\r\n,;}]*"#),
                "${1}[REDACTED]",
            ),
            (
                compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{4,}"),
                "${1} [REDACTED]",
            ),
            (
                compile(
                    r#"(?i)((?:api[_-]?key|access[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^"'\s,;}]+"#,
                ),
                "${1}[REDACTED]",
            ),
            (compile(r"[\x00-\x1f\x7f]+"), " "),
        ]
    })
}

/// One line of untrusted diagnostic text, bounded and without credentials:
/// known secrets, authorization headers, bearer or basic credentials and
/// credential-named fields are masked, and control characters become spaces.
pub fn sanitize_diagnostic(text: &str, limit: usize, secrets: &[&str]) -> String {
    let mut clean = text.to_string();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        clean = clean.replace(secret, REDACTED);
    }
    for (pattern, replacement) in sanitizers() {
        clean = pattern.replace_all(&clean, *replacement).to_string();
    }
    let clean = clean.trim();
    let count = clean.chars().count();
    if count > limit {
        format!(
            "{}… [{} more chars]",
            clean.chars().take(limit).collect::<String>(),
            count - limit
        )
    } else {
        clean.to_string()
    }
}

/// Structured diagnostics of an HTTP error response: httpStatus, errorType,
/// errorMessage, bodyPreview and bodyChars (same keys as JavaScript).
pub fn http_error_details(status: u16, text: &str, secrets: &[&str]) -> Value {
    let body: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let error = body.get("error").unwrap_or(&Value::Null);
    let (kind, message) = if error.is_object() {
        (
            error.get("type").and_then(Value::as_str),
            error.get("message").and_then(Value::as_str),
        )
    } else if let Some(text) = error.as_str() {
        (None, Some(text))
    } else {
        (None, body.get("message").and_then(Value::as_str))
    };
    json!({
        "httpStatus": status,
        "errorType": kind.map(|kind| sanitize_diagnostic(kind, 100, secrets)),
        "errorMessage": message.map(|message| sanitize_diagnostic(message, MESSAGE_CHARS, secrets)),
        "bodyPreview": sanitize_diagnostic(text, PREVIEW_CHARS, secrets),
        "bodyChars": text.encode_utf16().count(),
    })
}

/// `Formal AI returned HTTP <status>: [<type>: ]<message or preview>`.
pub fn http_error_message(details: &Value) -> String {
    let text = |key: &str| details[key].as_str().filter(|text| !text.is_empty());
    let cause = match (text("errorType"), text("errorMessage")) {
        (Some(kind), Some(message)) => format!("{}: {}", kind, message),
        (None, Some(message)) => message.to_string(),
        _ => {
            let preview: String = text("bodyPreview")
                .unwrap_or("")
                .chars()
                .take(MESSAGE_CHARS)
                .collect();
            if preview.is_empty() {
                "(empty body)".to_string()
            } else {
                preview
            }
        }
    };
    format!(
        "Formal AI returned HTTP {}: {}",
        details["httpStatus"], cause
    )
}

/// Known structured gaps Formal AI answers instead of claiming success.
pub const GAP_SCHEMAS: [(&str, &[&str]); 2] = [
    (
        "workspace-edit-capability-gap/v1",
        &["EditToolUnavailable", "ReadToolUnavailable"],
    ),
    // SourcePreimageUnavailable: Formal AI could not bind the complete Read
    // before its edit to the change (issue #261).
    (
        "workspace-change-verification-gap/v1",
        &[
            "VerificationRunToolUnavailable",
            "SourcePreimageUnavailable",
        ],
    ),
];
const CAPABILITIES: [&str; 6] = ["read", "edit", "multi_edit", "write", "run", "bash"];

/// Recognize a final answer that is exactly a known Formal AI capability
/// gap: {schema, target, reason, missingCapabilities, complete, verified}.
/// Only the runtime's own answer counts: text that a tool result in this run
/// contained (file data echoed back) is never taken as a gap.
pub fn recognize_capability_gap(content: &str, messages: &[Value]) -> Option<Value> {
    let text = content.trim();
    if !text.starts_with('{') || !text.ends_with('}') {
        return None;
    }
    let gap: Value = serde_json::from_str(text).ok()?;
    let schema = gap.get("schema").and_then(Value::as_str)?;
    let (_, reasons) = GAP_SCHEMAS.iter().find(|(name, _)| *name == schema)?;
    let reason = gap.get("reason").and_then(Value::as_str)?;
    let target = gap.get("target").and_then(Value::as_str)?;
    let missing = match gap.get("missingCapabilities") {
        None => Vec::new(),
        Some(value) => value.as_array()?.clone(),
    };
    let known = missing
        .iter()
        .all(|c| c.as_str().is_some_and(|c| CAPABILITIES.contains(&c)));
    if !reasons.contains(&reason)
        || gap.get("complete") != Some(&Value::Bool(false))
        || gap.get("verified") != Some(&Value::Bool(false))
        || target.trim().is_empty()
        || !known
    {
        return None;
    }
    if crate::formal_ai_files::echoed_by_tool(text, messages) {
        return None;
    }
    Some(json!({
        "schema": schema,
        "target": target,
        "reason": reason,
        "missingCapabilities": missing,
        "complete": false,
        "verified": false,
    }))
}

/// One tool call Formal AI asked for.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ToolCall {
    pub id: Option<String>,
    /// Name Formal AI used.
    pub name: String,
    /// "bash", or the file tool "read", "edit" or "write".
    pub tool: String,
    /// The bash command, or a one-line rendering of a file call.
    pub command: String,
    /// Raw JSON arguments of a file call, sent back unchanged.
    pub arguments: String,
    /// Normalized arguments of a file call.
    pub args: Option<FileArgs>,
}

/// One chat completion, normalized for the task loop.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Completion {
    pub content: String,
    pub finish_reason: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub handler: Option<String>,
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// Normalize one chat completion into what the loop needs.
pub fn parse_completion(body: &Value) -> Result<Completion, ClientError> {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .filter(|choice| choice.get("message").is_some_and(Value::is_object))
        .ok_or_else(|| ClientError::protocol("Formal AI response has no choices[0].message"))?;
    let message = &choice["message"];
    let handler = message
        .get("thinking_steps")
        .and_then(Value::as_array)
        .and_then(|steps| {
            steps
                .iter()
                .find(|s| s.get("step").and_then(Value::as_str) == Some("dispatch_handler"))
        })
        .map(|step| value_text(step.get("detail").unwrap_or(&Value::Null)));
    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let function = call.get("function");
            let name = function
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !TOOL_NAMES.contains(&name) {
                let shown = if name.is_empty() { "undefined" } else { name };
                return Err(ClientError::protocol(format!(
                    "Formal AI called an unsupported tool \"{}\"",
                    shown
                )));
            }
            let raw = function
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .unwrap_or("{}");
            let args: Value = serde_json::from_str(raw).map_err(|_| {
                ClientError::protocol(format!("Formal AI sent non-JSON arguments for {}", name))
            })?;
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
            if !BASH_NAMES.contains(&name) {
                let normalized = normalize_file_args(name, &args).map_err(|problem| {
                    ClientError::protocol(format!("Formal AI called {}", problem))
                })?;
                tool_calls.push(ToolCall {
                    id,
                    name: name.to_string(),
                    tool: name.to_string(),
                    command: describe_file_call(name, &normalized),
                    arguments: raw.to_string(),
                    args: Some(normalized),
                });
                continue;
            }
            let command = args
                .get("command")
                .filter(|v| !v.is_null())
                .or_else(|| args.get("cmd"))
                .and_then(Value::as_str)
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    ClientError::protocol(format!("Formal AI called {} without a command", name))
                })?;
            tool_calls.push(ToolCall {
                id,
                name: name.to_string(),
                tool: "bash".to_string(),
                command: command.to_string(),
                ..ToolCall::default()
            });
        }
    }
    Ok(Completion {
        content: message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        finish_reason: choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .filter(|reason| !reason.is_empty())
            .map(str::to_string),
        tool_calls,
        handler,
    })
}

/// Something that answers chat completions (HTTP, or a replay in tests).
pub trait CompletionClient {
    /// Send the conversation; `cancel` is polled while waiting.
    fn complete(
        &mut self,
        messages: &[Value],
        cancel: &dyn Fn() -> bool,
    ) -> Result<Completion, ClientError>;
    /// Requests sent so far (retries included).
    fn requests(&self) -> u64;
}

/// Why an HTTP exchange failed.
#[derive(Debug, Clone, PartialEq)]
pub enum HttpError {
    Timeout,
    Cancelled,
    Io(String),
}

/// Host, port and path prefix of an `http://host:port/prefix` URL.
pub fn parse_http_url(url: &str) -> Result<(String, u16, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("not an http:// URL: {}", url))?;
    let (authority, prefix) = match rest.find('/') {
        Some(index) => (&rest[..index], rest[index..].trim_end_matches('/')),
        None => (rest, ""),
    };
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let end = stripped
            .find(']')
            .ok_or_else(|| format!("invalid host in {}", url))?;
        let port = stripped[end + 1..].strip_prefix(':').unwrap_or("80");
        (stripped[..end].to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), port),
            None => (authority.to_string(), "80"),
        }
    };
    if host.is_empty() {
        return Err(format!("missing host in {}", url));
    }
    let port = port
        .parse::<u16>()
        .map_err(|_| format!("invalid port in {}", url))?;
    Ok((host, port, prefix.to_string()))
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// Decode a chunked body; None while it is incomplete.
fn decode_chunked(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = body.windows(2).position(|w| w == b"\r\n")?;
        let size_text = String::from_utf8_lossy(&body[..line_end]);
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if body.len() < size + 2 {
            return None;
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
    }
}

struct Head {
    status: u16,
    content_length: Option<usize>,
    chunked: bool,
}

fn parse_head(head: &[u8]) -> Result<Head, HttpError> {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| HttpError::Io("malformed HTTP response".to_string()))?;
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            if name == "content-length" {
                content_length = value.parse::<usize>().ok();
            } else if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }
    Ok(Head {
        status,
        content_length,
        chunked,
    })
}

/// Complete body of a buffered response, once it has fully arrived.
fn complete_body(buf: &[u8], closed: bool) -> Result<Option<(u16, Vec<u8>)>, HttpError> {
    let Some(end) = header_end(buf) else {
        return if closed {
            Err(HttpError::Io(
                "connection closed before a response".to_string(),
            ))
        } else {
            Ok(None)
        };
    };
    let head = parse_head(&buf[..end])?;
    let body = &buf[end..];
    if head.chunked {
        return match decode_chunked(body) {
            Some(decoded) => Ok(Some((head.status, decoded))),
            None if closed => Err(HttpError::Io("truncated chunked response".to_string())),
            None => Ok(None),
        };
    }
    match head.content_length {
        Some(length) if body.len() >= length => Ok(Some((head.status, body[..length].to_vec()))),
        Some(_) if closed => Err(HttpError::Io("truncated response".to_string())),
        Some(_) => Ok(None),
        None if closed => Ok(Some((head.status, body.to_vec()))),
        None => Ok(None),
    }
}

fn io_error(error: std::io::Error) -> HttpError {
    HttpError::Io(error.to_string())
}

/// One blocking HTTP/1.1 exchange with `Connection: close`.
pub fn http_request(
    base_url: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
    timeout: Duration,
    cancel: &dyn Fn() -> bool,
) -> Result<(u16, String), HttpError> {
    let (host, port, prefix) = parse_http_url(base_url).map_err(HttpError::Io)?;
    let deadline = Instant::now() + timeout;
    let remaining = || deadline.saturating_duration_since(Instant::now());
    let mut last = HttpError::Io(format!("cannot resolve {}", host));
    let mut stream = None;
    for addr in (host.as_str(), port).to_socket_addrs().map_err(io_error)? {
        if remaining().is_zero() {
            return Err(HttpError::Timeout);
        }
        match TcpStream::connect_timeout(&addr, remaining()) {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                last = HttpError::Timeout;
            }
            Err(error) => last = io_error(error),
        }
    }
    let mut stream = stream.ok_or(last)?;
    let mut request = format!(
        "{} {}{} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nAccept: application/json\r\n",
        method, prefix, path, host, port
    );
    if let Some(body) = body {
        request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    request.push_str("\r\n");
    request.push_str(body.unwrap_or(""));
    stream
        .set_write_timeout(Some(remaining().max(Duration::from_millis(1))))
        .map_err(io_error)?;
    stream.write_all(request.as_bytes()).map_err(io_error)?;
    stream.set_read_timeout(Some(POLL)).map_err(io_error)?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        if cancel() {
            return Err(HttpError::Cancelled);
        }
        if remaining().is_zero() {
            return Err(HttpError::Timeout);
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                let (status, body) = complete_body(&buf, true)?.unwrap_or_default();
                return Ok((status, String::from_utf8_lossy(&body).to_string()));
            }
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_RESPONSE_BYTES {
                    return Err(HttpError::Io("response too large".to_string()));
                }
                if let Some((status, body)) = complete_body(&buf, false)? {
                    return Ok((status, String::from_utf8_lossy(&body).to_string()));
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(io_error(error)),
        }
    }
}

/// Client bound to one runtime over HTTP.
pub struct HttpClient {
    pub base_url: String,
    pub max_retries: u64,
    pub deadline: Instant,
    pub requests: u64,
    /// Tools offered with every request (offered_tools() of the effect mode).
    pub tools: Vec<Value>,
}

impl HttpClient {
    /// A client offering the read-only tools; see with_tools().
    pub fn new(base_url: &str, max_retries: u64, deadline: Instant) -> Self {
        Self {
            base_url: base_url.to_string(),
            max_retries,
            deadline,
            requests: 0,
            tools: offered_tools("read-only"),
        }
    }

    /// Offer these tools instead (e.g. offered_tools(&bounds.effects)).
    pub fn with_tools(mut self, tools: Vec<Value>) -> Self {
        self.tools = tools;
        self
    }
}

fn budget_error() -> ClientError {
    ClientError::with_code(
        "time budget exhausted while waiting for Formal AI",
        EXIT_BUDGET,
    )
}

impl CompletionClient for HttpClient {
    fn complete(
        &mut self,
        messages: &[Value],
        cancel: &dyn Fn() -> bool,
    ) -> Result<Completion, ClientError> {
        let body = json!({
            "model": "formal-ai",
            "messages": messages,
            "tools": self.tools,
        })
        .to_string();
        let mut last_error = ClientError::protocol("Formal AI was not asked");
        let mut attempts: u64 = 0;
        for _ in 0..=self.max_retries {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(budget_error());
            }
            self.requests += 1;
            attempts += 1;
            let path = "/chat/completions";
            let full = format!("{}{}", API_PREFIX, path);
            match http_request(
                &self.base_url,
                "POST",
                &full,
                Some(&body),
                remaining,
                cancel,
            ) {
                Ok((status, text)) => {
                    if !(200..300).contains(&status) {
                        let mut details = http_error_details(status, &text, &[]);
                        details["attempts"] = json!(attempts);
                        let error = ClientError::protocol(http_error_message(&details))
                            .with_details(details);
                        // A server error may be transient: retry it within
                        // the bounds, keeping the latest diagnostics.
                        if status >= 500 {
                            last_error = error;
                            continue;
                        }
                        return Err(error);
                    }
                    let parsed: Value = serde_json::from_str(&text).map_err(|_| {
                        ClientError::protocol("Formal AI returned a non-JSON response")
                    })?;
                    return parse_completion(&parsed);
                }
                Err(HttpError::Cancelled) => {
                    let mut error = ClientError::protocol("cancelled");
                    error.cancelled = true;
                    return Err(error);
                }
                Err(HttpError::Timeout) => return Err(budget_error()),
                Err(HttpError::Io(message)) => {
                    let cause = sanitize_diagnostic(&message, MESSAGE_CHARS, &[]);
                    last_error = ClientError::with_code(
                        format!("Formal AI request failed: {}", cause),
                        EXIT_UNAVAILABLE,
                    )
                    .with_details(json!({ "cause": cause, "attempts": attempts }));
                }
            }
        }
        let retries = attempts.saturating_sub(1);
        if retries > 0 {
            let plural = if retries == 1 { "y" } else { "ies" };
            last_error.message =
                format!("{} (after {} retr{})", last_error.message, retries, plural);
        }
        if let Some(details) = last_error.details.as_mut() {
            details["attempts"] = json!(attempts);
        }
        Err(last_error)
    }

    fn requests(&self) -> u64 {
        self.requests
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tool_calls_and_handler() {
        let body = json!({"choices": [{"finish_reason": "tool_calls", "message": {
            "content": "",
            "tool_calls": [{"id": "c1", "function": {"name": "bash", "arguments": "{\"command\":\"ls\"}"}}],
            "thinking_steps": [{"step": "dispatch_handler", "detail": "list_files"}]
        }}]});
        let completion = parse_completion(&body).unwrap();
        assert_eq!(completion.handler.as_deref(), Some("list_files"));
        assert_eq!(completion.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(
            completion.tool_calls,
            vec![ToolCall {
                id: Some("c1".to_string()),
                name: "bash".to_string(),
                tool: "bash".to_string(),
                command: "ls".to_string(),
                ..ToolCall::default()
            }]
        );
    }

    #[test]
    fn rejects_malformed_completions() {
        let cases = [
            (json!({}), "Formal AI response has no choices[0].message"),
            (
                json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "python", "arguments": "{}"}}]}}]}),
                "Formal AI called an unsupported tool \"python\"",
            ),
            (
                json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "bash", "arguments": "ls"}}]}}]}),
                "Formal AI sent non-JSON arguments for bash",
            ),
            (
                json!({"choices": [{"message": {"tool_calls": [{"function": {"name": "shell", "arguments": "{\"cmd\":\" \"}"}}]}}]}),
                "Formal AI called shell without a command",
            ),
        ];
        for (body, message) in cases {
            let error = parse_completion(&body).unwrap_err();
            assert_eq!(error.message, message);
            assert_eq!(error.exit_code, EXIT_PROTOCOL);
        }
    }

    #[test]
    fn accepts_cmd_arguments() {
        let body = json!({"choices": [{"message": {"content": "ok",
            "tool_calls": [{"function": {"name": "run_command", "arguments": "{\"cmd\":\"pwd\"}"}}]}}]});
        let completion = parse_completion(&body).unwrap();
        assert_eq!(completion.tool_calls[0].command, "pwd");
        assert_eq!(completion.tool_calls[0].id, None);
        assert_eq!(completion.content, "ok");
    }

    #[test]
    fn parses_http_urls() {
        assert_eq!(
            parse_http_url("http://127.0.0.1:8080").unwrap(),
            ("127.0.0.1".to_string(), 8080, String::new())
        );
        assert_eq!(
            parse_http_url("http://localhost/base/").unwrap(),
            ("localhost".to_string(), 80, "/base".to_string())
        );
        assert_eq!(
            parse_http_url("http://[::1]:9/").unwrap(),
            ("::1".to_string(), 9, String::new())
        );
        assert!(parse_http_url("https://example.com").is_err());
        assert!(parse_http_url("http://:80").is_err());
    }

    #[test]
    fn decodes_content_length_and_chunked_bodies() {
        let fixed = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokEXTRA";
        assert_eq!(
            complete_body(fixed, false).unwrap(),
            Some((200, b"ok".to_vec()))
        );
        let partial = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nok";
        assert_eq!(complete_body(partial, false).unwrap(), None);
        assert!(complete_body(partial, true).is_err());
        let chunked = b"HTTP/1.1 503 Busy\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n";
        assert_eq!(
            complete_body(chunked, false).unwrap(),
            Some((503, b"abcde".to_vec()))
        );
        let open = b"HTTP/1.1 200 OK\r\n\r\nbody";
        assert_eq!(complete_body(open, false).unwrap(), None);
        assert_eq!(
            complete_body(open, true).unwrap(),
            Some((200, b"body".to_vec()))
        );
    }

    #[test]
    fn unreachable_server_is_unavailable_after_retries() {
        // Port 9 (discard) on loopback refuses connections on CI runners.
        let mut client = HttpClient::new(
            "http://127.0.0.1:9",
            1,
            Instant::now() + Duration::from_secs(10),
        );
        let error = client.complete(&[], &|| false).unwrap_err();
        assert_eq!(client.requests(), 2);
        if error.exit_code == EXIT_UNAVAILABLE {
            assert!(error.message.starts_with("Formal AI request failed: "));
            assert!(error.message.ends_with(" (after 1 retry)"));
        } else {
            assert_eq!(error.exit_code, EXIT_BUDGET);
        }
    }
}

#[cfg(test)]
#[path = "formal_ai_client_cases.rs"]
mod formal_ai_client_cases;
