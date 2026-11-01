//! Minimal client of the OpenAI-compatible agent-mode endpoint of Formal AI
//! (`POST /api/openai/v1/chat/completions`), used by `--use-formal-ai`
//! (issue #255). Mirrors js/src/lib/formal-ai-client.js. Only the `bash`
//! function tool is offered: Formal AI picks the command, start decides
//! whether and how it runs.
//!
//! The runtime is always a loopback `http://` server, so a small blocking
//! HTTP/1.1 client over `std::net` is enough; it polls for cancellation and
//! the time budget while it waits.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::formal_ai_policy::{EXIT_BUDGET, EXIT_PROTOCOL, EXIT_UNAVAILABLE};

pub const API_PREFIX: &str = "/api/openai/v1";
pub const TOOL_NAMES: [&str; 3] = ["bash", "shell", "run_command"];
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const POLL: Duration = Duration::from_millis(100);

/// The only tool offered to Formal AI.
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

/// A failed exchange with Formal AI and the exit status it maps to.
#[derive(Debug, Clone, PartialEq)]
pub struct ClientError {
    pub message: String,
    pub exit_code: i32,
    pub cancelled: bool,
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
        }
    }
}

/// One tool call Formal AI asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: Option<String>,
    pub name: String,
    pub command: String,
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
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map(str::to_string),
                name: name.to_string(),
                command: command.to_string(),
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
}

impl HttpClient {
    pub fn new(base_url: &str, max_retries: u64, deadline: Instant) -> Self {
        Self {
            base_url: base_url.to_string(),
            max_retries,
            deadline,
            requests: 0,
        }
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
            "tools": [bash_tool()],
        })
        .to_string();
        let mut last_error = ClientError::protocol("Formal AI was not asked");
        for _ in 0..=self.max_retries {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(budget_error());
            }
            self.requests += 1;
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
                    if status >= 500 {
                        last_error =
                            ClientError::protocol(format!("Formal AI returned HTTP {}", status));
                        continue;
                    }
                    if !(200..300).contains(&status) {
                        let shown: String = text.chars().take(300).collect();
                        return Err(ClientError::protocol(format!(
                            "Formal AI returned HTTP {}: {}",
                            status, shown
                        )));
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
                    last_error = ClientError::with_code(
                        format!("Formal AI request failed: {}", message),
                        EXIT_UNAVAILABLE,
                    );
                }
            }
        }
        if self.max_retries > 0 {
            let plural = if self.max_retries == 1 { "y" } else { "ies" };
            last_error.message = format!(
                "{} (after {} retr{})",
                last_error.message, self.max_retries, plural
            );
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
                command: "ls".to_string()
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
