//! Publish stored execution logs as bounded parts in a private GitHub repository.

use std::env;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};

use base64::prelude::*;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

use crate::execution_chain::{build_chain, chain_log_sources};
use crate::execution_store::ExecutionStore;
use crate::log_sanitizer::{
    blocked, ensure_sanitizer_available, error_code, spawn_log_sanitizer, LogSource,
};

const MAX_PART_BYTES: usize = 8 * 1024 * 1024;

fn setting(name: &str) -> Option<String> {
    env::var(format!("GH_UPLOAD_{name}"))
        .or_else(|_| env::var(format!("GH_UPLOAD_LOG_{name}")))
        .ok()
}

fn gh_command(args: &[&str]) -> Command {
    let mut command = Command::new("gh");
    command
        .args(["api", "--hostname", "github.com"])
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null());
    command
}

fn gh(args: &[&str]) -> io::Result<Output> {
    gh_command(args).output()
}

struct Repository {
    name: String,
    branch: String,
}

impl Repository {
    fn open() -> Result<Self, String> {
        let configured = setting("REPOSITORY").filter(|name| !name.is_empty());
        let name = match &configured {
            Some(name) => name.clone(),
            None => {
                let user = gh(&["user", "--jq", ".login"])
                    .ok()
                    .filter(|output| output.status.success())
                    .ok_or("Authenticate with the GitHub CLI to upload logs.")?;
                format!(
                    "{}/private-logs",
                    String::from_utf8_lossy(&user.stdout).trim()
                )
            }
        };
        let valid_name = regex::Regex::new(r"^[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$")
            .expect("static repository pattern");
        if !valid_name.is_match(&name) {
            return Err("Log upload repository must be in OWNER/REPO format.".into());
        }
        let endpoint = format!("repos/{name}");
        let lookup = || gh(&[&endpoint, "--jq", "{visibility, default_branch}"]);
        let unavailable = "Could not open the private GitHub log repository.";
        let mut output = lookup().map_err(|_| unavailable)?;
        if !output.status.success()
            && configured.is_none()
            && String::from_utf8_lossy(&output.stderr).contains("(HTTP 404)")
        {
            let _ = gh(&[
                "user/repos",
                "--method",
                "POST",
                "-f",
                "name=private-logs",
                "-F",
                "private=true",
                "-F",
                "auto_init=true",
                "--silent",
            ]);
            output = lookup().map_err(|_| unavailable)?;
        }
        if !output.status.success() {
            return Err(unavailable.into());
        }
        let info: Value = serde_json::from_slice(&output.stdout).map_err(|_| unavailable)?;
        if info["visibility"] != "private" {
            return Err("Log upload requires a private GitHub repository.".into());
        }
        let branch = setting("BRANCH")
            .filter(|branch| !branch.is_empty())
            .or_else(|| {
                info["default_branch"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(String::from)
            })
            .ok_or("The private GitHub log repository needs a branch.")?;
        Ok(Self { name, branch })
    }

    fn store(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let endpoint = format!("repos/{}/contents/{path}", self.name);
        let filename = path.rsplit('/').next().unwrap_or(path);
        let body = json!({
            "message": format!("Upload execution log {filename}"),
            "content": BASE64_STANDARD.encode(bytes),
            "branch": self.branch,
        })
        .to_string();
        // Git uses SHA-1 to identify a blob, including the type and length header.
        let blob_id = || {
            let mut hash = Sha1::new();
            hash.update(format!("blob {}\0", bytes.len()));
            hash.update(bytes);
            hash.finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        for _ in 0..3 {
            let saved = gh_command(&[&endpoint, "--method", "PUT", "--input", "-", "--silent"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .and_then(|mut child| {
                    let written = child.stdin.take().unwrap().write_all(body.as_bytes());
                    let status = child.wait()?;
                    Ok(written.is_ok() && status.success())
                });
            if matches!(saved, Ok(true)) {
                return Ok(());
            }
            // An interrupted response can hide a successful create-only PUT.
            let branch = format!("ref={}", self.branch);
            let existing = gh(&[
                &endpoint,
                "--method",
                "GET",
                "-f",
                &branch,
                "-H",
                "Accept: application/vnd.github.object+json",
                "--jq",
                ".sha",
            ]);
            if existing.is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).trim() == blob_id()
            }) {
                return Ok(());
            }
        }
        Err("GitHub could not confirm the log part or index.".into())
    }

    fn url(&self, kind: &str, path: &str) -> String {
        let mut branch = String::new();
        for byte in self.branch.bytes() {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                branch.push(char::from(byte));
            } else {
                branch.push_str(&format!("%{byte:02X}"));
            }
        }
        format!("https://github.com/{}/{kind}/{branch}/{path}", self.name)
    }
}

// Preserve arbitrary input bytes and avoid splitting a UTF-8 code point.
fn part_end(buffer: &[u8], limit: usize) -> usize {
    let mut start = limit;
    while start > limit - 3 && (buffer[start] & 0xc0) == 0x80 {
        start -= 1;
    }
    let width = match buffer[start] {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => 0,
    };
    if start + width > limit {
        start
    } else {
        limit
    }
}

struct Upload {
    repository: Option<Repository>,
    folder: String,
    count: u64,
    bytes: u64,
    dry_run: bool,
    verbose: bool,
}

impl Upload {
    fn target(&mut self) -> Result<&Repository, String> {
        if self.repository.is_none() {
            self.repository = Some(Repository::open()?);
        }
        Ok(self.repository.as_ref().unwrap())
    }

    fn folder_url(&self) -> Option<String> {
        self.repository
            .as_ref()
            .filter(|_| self.count > 0)
            .map(|repo| repo.url("tree", &self.folder))
    }

    fn part(&mut self, bytes: &[u8]) -> Result<(), String> {
        let number = self.count + 1;
        if !self.dry_run {
            let directory = (number - 1) / 1000 + 1;
            let path = format!("{}/parts/{directory:06}/part-{number:012}.log", self.folder);
            self.target()?.store(&path, bytes)?;
        }
        self.count = number;
        self.bytes += bytes.len() as u64;
        if number == 1 || self.verbose {
            if let Some(url) = self.folder_url() {
                println!("Published log part {number}: {url}");
            }
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), String> {
        let (count, bytes) = (self.count, self.bytes);
        if self.dry_run {
            println!("Dry run: {count} verified log part(s), {bytes} bytes.");
            return Ok(());
        }
        let instructions = if count == 0 {
            "The verified log is empty.\n"
        } else {
            "Read [the parts](parts/) in numeric order and concatenate their bytes. Each\n\
             folder contains up to 1000 consecutive parts.\n"
        };
        let text = format!(
            "# Execution log\n\nThis upload contains {count} part(s) and {bytes} bytes.\n\n{instructions}"
        );
        let path = format!("{}/README.md", self.folder);
        let target = self.target()?;
        target.store(&path, text.as_bytes())?;
        println!("Uploaded log: {}", target.url("blob", &path));
        Ok(())
    }
}

fn upload_sources(sources: &[LogSource], no_sanitize: bool, verbose: bool) -> Result<i32, String> {
    let limit = env::var("START_LOG_UPLOAD_PART_BYTES")
        .ok()
        .map(|value| {
            if value.bytes().all(|byte| byte.is_ascii_digit()) {
                value.parse::<usize>().unwrap_or(0)
            } else {
                0
            }
        })
        .unwrap_or(MAX_PART_BYTES);
    if !(4..=MAX_PART_BYTES).contains(&limit) {
        return Err(format!(
            "START_LOG_UPLOAD_PART_BYTES must be 4–{MAX_PART_BYTES}."
        ));
    }
    // The explicit opt-out skipped Start's extra pass. The previous uploader
    // still verified input, so the shared engine remains required in both modes.
    if verbose && no_sanitize {
        println!("The upload still verifies credentials with --no-sanitize.");
    }
    ensure_sanitizer_available()?;
    let mut child = spawn_log_sanitizer(sources)?;
    let mut output = child.stdout.take().unwrap();
    let mut upload = Upload {
        repository: None,
        folder: format!("start-upload-{}", uuid::Uuid::new_v4()),
        count: 0,
        bytes: 0,
        dry_run: setting("DRY_MODE").is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true")),
        verbose,
    };
    let mut buffer = vec![0; limit + 3];
    let mut length = 0;
    let result = (|| {
        loop {
            let count = output
                .read(&mut buffer[length..])
                .map_err(|_| blocked("ERR_SANITIZER", "Log"))?;
            if count == 0 {
                break;
            }
            length += count;
            if length == buffer.len() {
                let end = part_end(&buffer, limit);
                upload.part(&buffer[..end])?;
                buffer.copy_within(end..length, 0);
                length -= end;
            }
        }
        Ok::<_, String>(())
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    drop(output);
    let status = child.wait_with_output();
    let result = result.and_then(|_| {
        let status = status.map_err(|_| blocked("ERR_SANITIZER", "Log"))?;
        if !status.status.success() {
            return Err(blocked(&error_code(&status.stderr), "Log"));
        }
        // After EOF, publish the final bytes only when verification finished.
        let mut start = 0;
        if length > limit {
            start = part_end(&buffer, limit);
            upload.part(&buffer[..start])?;
        }
        if start < length {
            upload.part(&buffer[start..length])?;
        }
        upload.finish()
    });
    if result.is_err() {
        if let Some(url) = upload.folder_url() {
            eprintln!("Partial log available: {url}");
        }
    }
    result.map(|_| 0)
}

pub(crate) fn upload_log_path(
    log_path: &str,
    no_sanitize: bool,
    verbose: bool,
) -> Result<i32, String> {
    if log_path.is_empty() {
        return Err("Execution record does not have a log path.".into());
    }
    if !Path::new(log_path).exists() {
        return Err(format!("Log file not found: {log_path}"));
    }
    upload_sources(
        &[LogSource {
            path: log_path.to_owned(),
            header: None,
        }],
        no_sanitize,
        verbose,
    )
}

/// Upload the log for a stored execution by UUID or session name.
pub fn upload_execution_log(
    store: Option<&ExecutionStore>,
    identifier: &str,
) -> Result<i32, String> {
    upload_execution_log_with_options(store, identifier, false, false)
}

/// Upload the verified log and optionally print progress for every part.
pub fn upload_execution_log_with_options(
    store: Option<&ExecutionStore>,
    identifier: &str,
    no_sanitize: bool,
    verbose: bool,
) -> Result<i32, String> {
    let store = store.ok_or_else(|| "Execution tracking is disabled.".to_string())?;
    let record = store
        .get(identifier)
        .ok_or_else(|| format!("No execution found with UUID or session name: {identifier}"))?;
    let chain = build_chain(&store.get_all(), &record);
    if chain.len() > 1 {
        return upload_sources(&chain_log_sources(&chain), no_sanitize, verbose);
    }
    upload_log_path(&record.log_path, no_sanitize, verbose)
}
