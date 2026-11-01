//! Resolution and identity of the Formal AI runtime used by `--use-formal-ai`
//! (issue #255). Mirrors js/src/lib/formal-ai-runtime.js.
//!
//! Formal AI is not published to a registry, so start never installs or
//! guesses a runtime. It uses exactly one of:
//! - START_FORMAL_AI_ROOT: a link-assistant/formal-ai checkout whose
//!   JavaScript server (`js/server/main.mjs --agent-mode`) start spawns on a
//!   private loopback port with a private memory directory;
//! - START_FORMAL_AI_URL: an already running Formal AI server, which reports
//!   no version, so it is used only with START_FORMAL_AI_ALLOW_UNVERIFIED=1.
//!
//! Without either, or with a runtime older than the qualified version, the
//! mode fails; it never falls back to an LLM, the alias table or a shell.

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::formal_ai_client::{http_request, HttpError, API_PREFIX};
use crate::formal_ai_policy::Bounds;

/// The Formal AI release this mode was qualified against.
pub const MIN_FORMAL_AI_VERSION: &str = "0.355.27";
pub const SERVER_ENTRY: &str = "js/server/main.mjs";
pub const INSTALL_HINT: &str = "Install Formal AI from https://github.com/link-assistant/formal-ai (git clone https://github.com/link-assistant/formal-ai.git) and set START_FORMAL_AI_ROOT to the checkout, or set START_FORMAL_AI_URL to a running server. See docs/formal-ai.md.";

/// Compare dotted numeric versions; None when either is not one.
pub fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let parse = |v: &str| -> Option<Vec<u64>> {
        if v.is_empty() {
            return None;
        }
        v.split('.')
            .map(|part| {
                if !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()) {
                    part.parse::<u64>().ok()
                } else {
                    None
                }
            })
            .collect()
    };
    let a = parse(left)?;
    let b = parse(right)?;
    for i in 0..a.len().max(b.len()) {
        let order = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if order != std::cmp::Ordering::Equal {
            return Some(order);
        }
    }
    Some(std::cmp::Ordering::Equal)
}

/// `version` of the `[package]` table of `<root>/rust/Cargo.toml`.
pub fn read_cargo_version(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("rust").join("Cargo.toml")).ok()?;
    let mut in_package = false;
    for line in text.lines() {
        if line.starts_with('[') {
            in_package = line.starts_with("[package]");
            continue;
        }
        if !in_package {
            continue;
        }
        if let Some(rest) = line.strip_prefix("version") {
            let rest = rest.trim_start();
            if let Some(value) = rest.strip_prefix('=') {
                let value = value.trim();
                if let Some(inner) = value.strip_prefix('"') {
                    if let Some(end) = inner.find('"') {
                        if end > 0 {
                            return Some(inner[..end].to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn read_json_version(file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(file).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn run_text(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

/// Exact source identity of the runtime, recorded in logs and evidence.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RuntimeIdentity {
    /// `checkout` or `url`
    pub source: String,
    pub url: Option<String>,
    pub root: Option<String>,
    pub entry: Option<String>,
    pub version: Option<String>,
    pub engine_version: Option<String>,
    pub commit: Option<String>,
    pub dirty: Option<bool>,
    pub node: Option<String>,
    pub node_version: Option<String>,
    pub memory: Option<String>,
    pub port: Option<u16>,
}

impl RuntimeIdentity {
    /// Same keys as the JavaScript identity object.
    pub fn to_json(&self) -> Value {
        if self.source == "url" {
            return json!({ "source": "url", "url": self.url });
        }
        let mut value = json!({
            "source": self.source,
            "root": self.root,
            "entry": self.entry,
            "version": self.version,
            "engineVersion": self.engine_version,
            "commit": self.commit,
            "dirty": self.dirty,
            "node": self.node,
            "nodeVersion": self.node_version,
        });
        if let Some(memory) = &self.memory {
            value["memory"] = json!(memory);
        }
        if let Some(port) = self.port {
            value["port"] = json!(port);
        }
        value
    }
}

/// Source identity of a Formal AI checkout.
pub fn checkout_identity(root: &Path, node: &str) -> RuntimeIdentity {
    let root_text = root.to_string_lossy().to_string();
    let commit = run_text("git", &["-C", &root_text, "rev-parse", "HEAD"]);
    let status = commit
        .as_ref()
        .and_then(|_| run_text("git", &["-C", &root_text, "status", "--porcelain"]));
    RuntimeIdentity {
        source: "checkout".to_string(),
        root: Some(root_text),
        entry: Some(SERVER_ENTRY.to_string()),
        version: read_cargo_version(root),
        engine_version: read_json_version(
            &root
                .join("packages")
                .join("formal-ai-engine")
                .join("package.json"),
        ),
        commit,
        dirty: status.map(|s| !s.is_empty()),
        node: Some(node.to_string()),
        node_version: run_text(node, &["--version"]),
        ..RuntimeIdentity::default()
    }
}

/// One-line rendering of an identity for terminals and logs.
pub fn describe_identity(identity: &RuntimeIdentity) -> String {
    if identity.source == "url" {
        return format!(
            "formal-ai at {} (version unverified)",
            identity.url.as_deref().unwrap_or("")
        );
    }
    let commit = match &identity.commit {
        Some(commit) if !commit.is_empty() => format!(
            "{}{}",
            commit.chars().take(12).collect::<String>(),
            if identity.dirty == Some(true) {
                "+dirty"
            } else {
                ""
            }
        ),
        _ => "no git commit".to_string(),
    };
    format!(
        "formal-ai {} ({}, js server {}, node {})",
        identity.version.as_deref().unwrap_or("unknown"),
        commit,
        identity.entry.as_deref().unwrap_or(SERVER_ENTRY),
        identity.node_version.as_deref().unwrap_or("unknown")
    )
}

/// Check a resolved identity against the qualified version and an optional
/// START_FORMAL_AI_EXPECTED_REVISION pin.
pub fn qualify_identity(
    identity: &RuntimeIdentity,
    get: &dyn Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let expected = get("START_FORMAL_AI_EXPECTED_REVISION")
        .unwrap_or_default()
        .trim()
        .to_string();
    if identity.source == "url" {
        if get("START_FORMAL_AI_ALLOW_UNVERIFIED").as_deref() != Some("1") {
            return Err(format!(
                "START_FORMAL_AI_URL={} does not report its Formal AI version, so it cannot be qualified. Set START_FORMAL_AI_ALLOW_UNVERIFIED=1 to use it anyway, or use START_FORMAL_AI_ROOT.",
                identity.url.as_deref().unwrap_or("")
            ));
        }
        return Ok(());
    }
    if identity.node_version.is_none() {
        return Err(format!(
            "Cannot run \"{} --version\"; set START_FORMAL_AI_NODE to a Node.js executable.",
            identity.node.as_deref().unwrap_or("node")
        ));
    }
    let root = identity.root.as_deref().unwrap_or("");
    let version = identity.version.as_deref().unwrap_or("");
    let order = compare_versions(version, MIN_FORMAL_AI_VERSION);
    if order.is_none_or(|o| o == std::cmp::Ordering::Less) {
        return Err(format!(
            "Formal AI at {} is version {}; --use-formal-ai needs {} or newer. Update the checkout (git pull).",
            root,
            if version.is_empty() { "unknown" } else { version },
            MIN_FORMAL_AI_VERSION
        ));
    }
    let pinned = identity
        .commit
        .as_deref()
        .is_some_and(|commit| commit.starts_with(&expected.to_lowercase()));
    if !expected.is_empty() && !pinned {
        return Err(format!(
            "Formal AI at {} is at commit {}, not START_FORMAL_AI_EXPECTED_REVISION={}.",
            root,
            identity.commit.as_deref().unwrap_or("unknown"),
            expected
        ));
    }
    Ok(())
}

/// A resolved runtime; a spawned server is stopped on `stop()` or drop.
pub struct Runtime {
    pub base_url: String,
    pub identity: RuntimeIdentity,
    child: Option<Child>,
    home: Option<PathBuf>,
}

impl Runtime {
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Ok(None) = child.try_wait() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        if let Some(home) = self.home.take() {
            let _ = std::fs::remove_dir_all(home);
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

fn private_home() -> Result<PathBuf, String> {
    let base = std::env::temp_dir();
    for attempt in 0..100u32 {
        let candidate = base.join(format!(
            "start-formal-ai-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
                .simple()
                .to_string()
                .get(..8)
                .unwrap_or("x")
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 99 => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("cannot create a private Formal AI home".to_string())
}

/// Resolve, qualify and (for a checkout) start the runtime.
pub fn start_runtime(
    get: &dyn Fn(&str) -> Option<String>,
    bounds: &Bounds,
    cancel: &dyn Fn() -> bool,
) -> Result<Runtime, String> {
    let url = get("START_FORMAL_AI_URL")
        .unwrap_or_default()
        .trim()
        .to_string();
    let root = get("START_FORMAL_AI_ROOT")
        .unwrap_or_default()
        .trim()
        .to_string();
    if !url.is_empty() && !root.is_empty() {
        return Err("Set only one of START_FORMAL_AI_URL and START_FORMAL_AI_ROOT.".to_string());
    }
    if !url.is_empty() {
        if !url.starts_with("http://") {
            return Err(format!(
                "START_FORMAL_AI_URL must be an http:// URL, got \"{}\"",
                url
            ));
        }
        let identity = RuntimeIdentity {
            source: "url".to_string(),
            url: Some(url.trim_end_matches('/').to_string()),
            ..RuntimeIdentity::default()
        };
        qualify_identity(&identity, get)?;
        return Ok(Runtime {
            base_url: identity.url.clone().unwrap_or_default(),
            identity,
            child: None,
            home: None,
        });
    }
    if root.is_empty() {
        return Err(format!(
            "--use-formal-ai needs a Formal AI runtime and has no fallback. {}",
            INSTALL_HINT
        ));
    }
    let absolute_root = std::env::current_dir()
        .map(|cwd| cwd.join(&root))
        .unwrap_or_else(|_| PathBuf::from(&root));
    if !absolute_root.join(SERVER_ENTRY).exists() {
        return Err(format!(
            "START_FORMAL_AI_ROOT={} has no {}. {}",
            root, SERVER_ENTRY, INSTALL_HINT
        ));
    }
    let node = get("START_FORMAL_AI_NODE")
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "node".to_string())
        .trim()
        .to_string();
    let identity = checkout_identity(&absolute_root, &node);
    qualify_identity(&identity, get)?;
    spawn_server(&absolute_root, &node, identity, get, bounds, cancel)
}

fn spawn_server(
    root: &Path,
    node: &str,
    mut identity: RuntimeIdentity,
    get: &dyn Fn(&str) -> Option<String>,
    bounds: &Bounds,
    cancel: &dyn Fn() -> bool,
) -> Result<Runtime, String> {
    let port = free_port()?;
    let home = private_home()?;
    let memory = get("START_FORMAL_AI_MEMORY_PATH")
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut command = Command::new(node);
    command
        .arg(format!("--max-old-space-size={}", bounds.max_memory_mb))
        .arg(root.join(SERVER_ENTRY))
        .args(["--agent-mode", "--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .arg("--silent")
        .current_dir(root)
        .env_clear()
        .env("PATH", get("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env(
            "FORMAL_AI_MEMORY_PATH",
            if memory.is_empty() {
                home.join("memory.lino")
            } else {
                PathBuf::from(&memory)
            },
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    for name in ["LANG", "SYSTEMROOT"] {
        if let Some(value) = get(name).filter(|v| !v.is_empty()) {
            command.env(name, value);
        }
    }
    identity.memory = Some(
        if memory.is_empty() {
            "private"
        } else {
            "START_FORMAL_AI_MEMORY_PATH"
        }
        .to_string(),
    );
    let mut runtime = Runtime {
        base_url: format!("http://127.0.0.1:{}", port),
        identity,
        child: None,
        home: Some(home),
    };
    let stderr = Arc::new(Mutex::new(String::new()));
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Err(format!(
                "Formal AI server did not become ready in time ({})",
                error
            ))
        }
    };
    if let Some(mut pipe) = child.stderr.take() {
        let sink = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut text) = sink.lock() {
                    text.push_str(&String::from_utf8_lossy(&buf[..n]));
                    let excess = text.len().saturating_sub(4096);
                    if excess > 0 {
                        let cut = (excess..=text.len())
                            .find(|i| text.is_char_boundary(*i))
                            .unwrap_or(text.len());
                        text.drain(..cut);
                    }
                }
            }
        });
    }
    runtime.child = Some(child);
    let deadline = Instant::now() + Duration::from_millis(bounds.startup_timeout_ms);
    if let Err(message) = wait_ready(&mut runtime, deadline, cancel) {
        runtime.stop();
        let tail = stderr
            .lock()
            .map(|t| t.trim().to_string())
            .unwrap_or_default();
        if tail.is_empty() {
            return Err(message);
        }
        let start = tail.chars().count().saturating_sub(500);
        let tail: String = tail.chars().skip(start).collect();
        return Err(format!("{}: {}", message, tail));
    }
    runtime.identity.port = Some(port);
    Ok(runtime)
}

fn wait_ready(
    runtime: &mut Runtime,
    deadline: Instant,
    cancel: &dyn Fn() -> bool,
) -> Result<(), String> {
    let mut last_error = "no response".to_string();
    while Instant::now() < deadline {
        if cancel() {
            return Err("Formal AI server startup was cancelled".to_string());
        }
        if let Some(child) = runtime.child.as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                let code = status
                    .code()
                    .map_or_else(|| "signal".to_string(), |c| c.to_string());
                return Err(format!("Formal AI server exited during startup ({})", code));
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match http_request(
            &runtime.base_url,
            "GET",
            &format!("{}/models", API_PREFIX),
            None,
            remaining.min(Duration::from_secs(2)),
            cancel,
        ) {
            Ok((status, _)) if (200..300).contains(&status) => return Ok(()),
            Ok((status, _)) => last_error = format!("HTTP {}", status),
            Err(HttpError::Timeout) => last_error = "timeout".to_string(),
            Err(HttpError::Cancelled) => {
                return Err("Formal AI server startup was cancelled".to_string())
            }
            Err(HttpError::Io(message)) => last_error = message,
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "Formal AI server did not become ready in time ({})",
        last_error
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    fn checkout(version: &str) -> RuntimeIdentity {
        RuntimeIdentity {
            source: "checkout".to_string(),
            root: Some("/fa".to_string()),
            entry: Some(SERVER_ENTRY.to_string()),
            version: Some(version.to_string()),
            commit: Some("0123456789abcdef".to_string()),
            dirty: Some(false),
            node: Some("node".to_string()),
            node_version: Some("v24.0.0".to_string()),
            ..RuntimeIdentity::default()
        }
    }

    #[test]
    fn compares_dotted_versions() {
        assert_eq!(
            compare_versions("0.355.27", "0.355.27"),
            Some(Ordering::Equal)
        );
        assert_eq!(
            compare_versions("0.355.28", "0.355.27"),
            Some(Ordering::Greater)
        );
        assert_eq!(compare_versions("0.355", "0.355.1"), Some(Ordering::Less));
        assert_eq!(
            compare_versions("1.0", "0.999.999"),
            Some(Ordering::Greater)
        );
        assert_eq!(compare_versions("1.0-beta", "1.0"), None);
        assert_eq!(compare_versions("", "1.0"), None);
    }

    #[test]
    fn reads_the_package_version_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("rust")).unwrap();
        std::fs::write(
            dir.path().join("rust").join("Cargo.toml"),
            "[workspace]\nversion = \"9.9.9\"\n\n[package]\nname = \"formal-ai\"\nversion = \"0.355.27\"\n\n[dependencies]\nversion = \"1\"\n",
        )
        .unwrap();
        assert_eq!(read_cargo_version(dir.path()).as_deref(), Some("0.355.27"));
        assert_eq!(read_cargo_version(&dir.path().join("missing")), None);
    }

    #[test]
    fn qualifies_versions_revisions_and_urls() {
        let none = env(&[]);
        assert!(qualify_identity(&checkout("0.355.27"), &none).is_ok());
        let old = qualify_identity(&checkout("0.355.26"), &none).unwrap_err();
        assert!(old.contains("needs 0.355.27 or newer"), "{}", old);
        let pin = env(&[("START_FORMAL_AI_EXPECTED_REVISION", "0123AB")]);
        assert!(qualify_identity(
            &checkout("0.355.27"),
            &env(&[("START_FORMAL_AI_EXPECTED_REVISION", "0123")])
        )
        .is_ok());
        let pinned = qualify_identity(&checkout("0.355.27"), &pin).unwrap_err();
        assert!(pinned.contains("not START_FORMAL_AI_EXPECTED_REVISION=0123AB"));
        let mut no_node = checkout("0.355.27");
        no_node.node_version = None;
        assert!(qualify_identity(&no_node, &none)
            .unwrap_err()
            .contains("set START_FORMAL_AI_NODE"));
        let url = RuntimeIdentity {
            source: "url".to_string(),
            url: Some("http://127.0.0.1:9".to_string()),
            ..RuntimeIdentity::default()
        };
        assert!(qualify_identity(&url, &none)
            .unwrap_err()
            .contains("cannot be qualified"));
        assert!(qualify_identity(&url, &env(&[("START_FORMAL_AI_ALLOW_UNVERIFIED", "1")])).is_ok());
    }

    #[test]
    fn describes_identities() {
        let mut identity = checkout("0.355.27");
        identity.dirty = Some(true);
        assert_eq!(
            describe_identity(&identity),
            "formal-ai 0.355.27 (0123456789ab+dirty, js server js/server/main.mjs, node v24.0.0)"
        );
        identity.commit = None;
        assert!(describe_identity(&identity).contains("(no git commit, "));
        let url = RuntimeIdentity {
            source: "url".to_string(),
            url: Some("http://h:1".to_string()),
            ..RuntimeIdentity::default()
        };
        assert_eq!(
            describe_identity(&url),
            "formal-ai at http://h:1 (version unverified)"
        );
        assert_eq!(url.to_json(), json!({"source": "url", "url": "http://h:1"}));
    }

    #[test]
    fn resolution_never_falls_back() {
        let bounds = Bounds::default();
        let never = || false;
        let cases: Vec<(Vec<(&str, &str)>, &str)> = vec![
            (vec![], "needs a Formal AI runtime and has no fallback"),
            (
                vec![
                    ("START_FORMAL_AI_URL", "http://a"),
                    ("START_FORMAL_AI_ROOT", "/b"),
                ],
                "Set only one of",
            ),
            (
                vec![("START_FORMAL_AI_URL", "ftp://a")],
                "must be an http:// URL",
            ),
            (
                vec![("START_FORMAL_AI_URL", "https://a")],
                "must be an http:// URL",
            ),
            (
                vec![("START_FORMAL_AI_URL", "http://127.0.0.1:9")],
                "cannot be qualified",
            ),
            (
                vec![("START_FORMAL_AI_ROOT", "/nonexistent/formal-ai")],
                "has no js/server/main.mjs",
            ),
        ];
        for (pairs, message) in cases {
            let error = start_runtime(&env(&pairs), &bounds, &never)
                .err()
                .expect("must fail");
            assert!(error.contains(message), "{} !~ {}", error, message);
        }
        let runtime = match start_runtime(
            &env(&[
                ("START_FORMAL_AI_URL", "http://127.0.0.1:9/"),
                ("START_FORMAL_AI_ALLOW_UNVERIFIED", "1"),
            ]),
            &bounds,
            &never,
        ) {
            Ok(runtime) => runtime,
            Err(error) => panic!("unverified URL must be allowed: {}", error),
        };
        assert_eq!(runtime.base_url, "http://127.0.0.1:9");
    }
}
