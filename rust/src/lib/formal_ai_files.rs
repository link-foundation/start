//! Structured `read`, `edit` and `write` tools of the experimental
//! `--use-formal-ai` mode (issue #258). Mirrors js/src/lib/formal-ai-files.js.
//!
//! The `bash` tool runs only programs without shell syntax, and its write
//! programs (cp, mkdir, mv, rm, rmdir, touch) cannot change the text of a
//! file. These three tools are the guarded replacement primitive instead of an
//! interpreter: start itself reads and writes the one named workspace file,
//! byte for byte, so comments, whitespace and unrelated content survive.
//!
//! - read: the exact UTF-8 text of a regular file, bounded by
//!   START_FORMAL_AI_MAX_FILE_BYTES; it observes the file for later changes.
//! - edit: replaces one literal occurrence of old_string (or every one with
//!   replace_all) in a file read before, atomically, then reads it back.
//! - write: replaces an observed file, or creates one in an observed
//!   directory, atomically, then reads it back.
//!
//! Paths follow the bash tool's workspace policy (no absolute, escaping or
//! symlinked-out paths), edit and write need START_FORMAL_AI_EFFECTS=
//! workspace-write and an earlier observation of the target, and a file that
//! changed since start read it is not overwritten.

use std::fs::{self, OpenOptions, Permissions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::formal_ai_policy::{parent_of, workspace_path, PolicyContext, Verification};

pub const FILE_TOOL_NAMES: [&str; 3] = ["read", "edit", "write"];

fn path_schema() -> Value {
    json!({ "type": "string", "description": "File path inside the working directory" })
}

/// The JSON schema of one file tool, as offered to Formal AI.
pub fn file_tool(name: &str) -> Value {
    let (description, properties, required) = match name {
        "read" => (
            "Read the exact text of one file in the working directory.",
            json!({ "path": path_schema() }),
            json!(["path"]),
        ),
        "edit" => (
            "Replace the literal text old_string with new_string in one file read before; old_string must occur exactly once unless replace_all is true.",
            json!({
                "path": path_schema(),
                "old_string": { "type": "string" },
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean" },
            }),
            json!(["path", "old_string", "new_string"]),
        ),
        _ => (
            "Write the whole text of one file: a file read before, or a new file in a directory listed before.",
            json!({ "path": path_schema(), "content": { "type": "string" } }),
            json!(["path", "content"]),
        ),
    };
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": { "type": "object", "properties": properties, "required": required },
        },
    })
}

/// Normalized arguments of a file tool call.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FileArgs {
    pub path: String,
    pub old_string: Option<String>,
    pub new_string: Option<String>,
    pub replace_all: bool,
    pub content: Option<String>,
}

/// Argument names Formal AI and other agents use for the same field.
const PATH: &[&str] = &["path", "filePath", "file_path"];
const OLD: &[&str] = &["old_string", "oldString", "old_str", "old"];
const NEW: &[&str] = &["new_string", "newString", "new_str", "new"];
const REPLACE_ALL: &[&str] = &["replace_all", "replaceAll"];
const CONTENT: &[&str] = &["content"];

fn fields(tool: &str) -> &'static [&'static [&'static str]] {
    match tool {
        "read" => &[PATH],
        "edit" => &[PATH, OLD, NEW, REPLACE_ALL],
        _ => &[PATH, CONTENT],
    }
}

fn required(tool: &str) -> &'static [&'static [&'static str]] {
    match tool {
        "read" => &[PATH],
        "edit" => &[PATH, OLD, NEW],
        _ => &[PATH, CONTENT],
    }
}

/// Normalize the JSON arguments of a file tool call, or say what is wrong.
pub fn normalize_file_args(tool: &str, args: &Value) -> Result<FileArgs, String> {
    let Some(object) = args.as_object() else {
        return Err(format!("{} arguments are not a JSON object", tool));
    };
    let mut found: Vec<(&str, Value)> = Vec::new();
    for aliases in fields(tool) {
        let boolean = *aliases == REPLACE_ALL;
        let kind = if boolean { "boolean" } else { "string" };
        let values: Vec<&Value> = aliases.iter().filter_map(|key| object.get(*key)).collect();
        if values
            .iter()
            .any(|value| (boolean && !value.is_boolean()) || (!boolean && !value.is_string()))
        {
            return Err(format!(
                "{} argument {} must be a {}",
                tool, aliases[0], kind
            ));
        }
        if values.iter().any(|value| *value != values[0]) {
            return Err(format!(
                "{} received conflicting {} values",
                tool, aliases[0]
            ));
        }
        if let Some(value) = values.first() {
            found.push((aliases[0], (*value).clone()));
        }
    }
    let missing: Vec<&str> = required(tool)
        .iter()
        .map(|aliases| aliases[0])
        .filter(|name| !found.iter().any(|(key, _)| key == name))
        .collect();
    if !missing.is_empty() {
        return Err(format!("{} needs {}", tool, missing.join(", ")));
    }
    let text = |name: &str| {
        found
            .iter()
            .find(|(key, _)| *key == name)
            .and_then(|(_, value)| value.as_str())
            .map(str::to_string)
    };
    let result = FileArgs {
        path: text("path").unwrap_or_default(),
        old_string: text("old_string"),
        new_string: text("new_string"),
        replace_all: found
            .iter()
            .find(|(key, _)| *key == "replace_all")
            .and_then(|(_, value)| value.as_bool())
            .unwrap_or(false),
        content: text("content"),
    };
    if result.path.trim().is_empty() || result.path.contains('\0') {
        return Err(format!("{} needs a non-empty path", tool));
    }
    Ok(result)
}

/// One-line rendering of a file call for notes and evidence.
pub fn describe_file_call(tool: &str, args: &FileArgs) -> String {
    format!("{} {}", tool, args.path)
}

/// Whether a file tool call may run (the effect policy of #255).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FileDecision {
    pub allowed: bool,
    pub reason: Option<String>,
    /// "read" or "write".
    pub kind: Option<&'static str>,
    pub target: Option<String>,
}

fn refuse(reason: String) -> FileDecision {
    FileDecision {
        allowed: false,
        reason: Some(reason),
        ..FileDecision::default()
    }
}

fn root_of(cwd: &Path) -> PathBuf {
    fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf())
}

/// Decide whether a file tool call may run.
pub fn evaluate_file_call(tool: &str, args: &FileArgs, context: &PolicyContext) -> FileDecision {
    let kind = if tool == "read" { "read" } else { "write" };
    if kind == "write" && context.effects != "workspace-write" {
        return refuse(format!(
            "\"{}\" changes files; the effect mode is read-only (set START_FORMAL_AI_EFFECTS=workspace-write to allow workspace changes)",
            tool
        ));
    }
    let outside = || {
        refuse(format!(
            "\"{}\" is outside the working directory",
            args.path
        ))
    };
    if args.path.starts_with('~') {
        return outside();
    }
    let Some(target) = workspace_path(&context.cwd, &args.path) else {
        return outside();
    };
    if target == "." {
        return refuse(format!(
            "\"{}\" is the working directory, not a file",
            args.path
        ));
    }
    if kind == "write" {
        let exists = root_of(&context.cwd).join(&target).exists();
        let observed = context.observed.contains(&target)
            || (tool == "write" && !exists && context.observed_dirs.contains(&parent_of(&target)));
        if !observed {
            return refuse(format!(
                "target \"{}\" was not {} before the change",
                target,
                if tool == "edit" { "read" } else { "observed" }
            ));
        }
    }
    FileDecision {
        allowed: true,
        reason: None,
        kind: Some(kind),
        target: Some(target),
    }
}

/// Hex SHA-256 of some bytes.
pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

struct FileText {
    text: String,
    bytes: Vec<u8>,
    permissions: Permissions,
}

/// Text of a regular workspace file, refusing what read could not return exactly.
fn read_text(file: &Path, max_file_bytes: u64) -> Result<FileText, String> {
    let meta = fs::metadata(file).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "no such file".to_string()
        } else {
            format!("cannot read the file ({})", error)
        }
    })?;
    if meta.is_dir() {
        return Err("is a directory, not a file".to_string());
    }
    if !meta.is_file() {
        return Err("is not a regular file".to_string());
    }
    let too_large = |size: u64| {
        format!(
            "has {} bytes; START_FORMAL_AI_MAX_FILE_BYTES is {}",
            size, max_file_bytes
        )
    };
    if meta.len() > max_file_bytes {
        return Err(too_large(meta.len()));
    }
    let bytes = fs::read(file).map_err(|error| format!("cannot read the file ({})", error))?;
    if bytes.len() as u64 > max_file_bytes {
        return Err(too_large(bytes.len() as u64));
    }
    match std::str::from_utf8(&bytes) {
        Ok(text) if !text.contains('\0') => Ok(FileText {
            text: text.to_string(),
            bytes: bytes.clone(),
            permissions: meta.permissions(),
        }),
        _ => Err("is not UTF-8 text".to_string()),
    }
}

/// Replace `file` by `content` through a temporary sibling and a rename.
fn write_atomically(
    file: &Path,
    content: &[u8],
    permissions: Option<Permissions>,
) -> std::io::Result<()> {
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let temporary = file.with_file_name(format!(
        ".{}.{}.{}.start-tmp",
        name,
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        handle.write_all(content)?;
        if let Some(permissions) = permissions {
            fs::set_permissions(&temporary, permissions)?;
        }
        handle.sync_all()?;
        drop(handle);
        fs::rename(&temporary, file)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

/// What an approved file call did.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FileReceipt {
    pub exit_code: i32,
    /// Tool message for Formal AI: the exact text of a read, empty after a
    /// change, a JSON error otherwise.
    pub result: String,
    /// Text a read returned.
    pub text: Option<String>,
    pub error: Option<String>,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub previous_sha256: Option<String>,
    pub replacements: Option<usize>,
    pub verification: Option<Verification>,
}

impl FileReceipt {
    /// Fields of the receipt the evidence keeps (as JavaScript names them).
    pub fn evidence(&self) -> Value {
        let mut out = json!({ "exitCode": self.exit_code });
        if let Some(error) = &self.error {
            out["error"] = json!(error);
        }
        if let Some(bytes) = self.bytes {
            out["bytes"] = json!(bytes);
        }
        if let Some(sha) = &self.sha256 {
            out["sha256"] = json!(sha);
        }
        if let Some(sha) = &self.previous_sha256 {
            out["previousSha256"] = json!(sha);
        }
        if let Some(count) = self.replacements {
            out["replacements"] = json!(count);
        }
        out
    }
}

fn fail(target: &str, message: &str) -> FileReceipt {
    let error = format!("{}: {}", target, message);
    FileReceipt {
        exit_code: 1,
        result: json!({ "ok": false, "is_error": true, "error": error }).to_string(),
        error: Some(error),
        ..FileReceipt::default()
    }
}

/// Run an approved file tool call. `context.contents` maps paths to the
/// SHA-256 start last saw, so a file changed since then is not overwritten.
pub fn run_file_call(
    tool: &str,
    args: &FileArgs,
    decision: &FileDecision,
    context: &mut PolicyContext,
    max_file_bytes: u64,
) -> FileReceipt {
    let target = decision.target.clone().unwrap_or_default();
    let file = root_of(&context.cwd).join(&target);
    if tool == "read" {
        return match read_text(&file, max_file_bytes) {
            Ok(read) => {
                let sha = sha256_hex(&read.bytes);
                context.observed.insert(target.clone());
                context.contents.insert(target, sha.clone());
                FileReceipt {
                    exit_code: 0,
                    result: read.text.clone(),
                    text: Some(read.text),
                    bytes: Some(read.bytes.len() as u64),
                    sha256: Some(sha),
                    ..FileReceipt::default()
                }
            }
            Err(message) => fail(&target, &message),
        };
    }
    let mut current = None;
    if tool == "edit" || file.exists() {
        match read_text(&file, max_file_bytes) {
            Ok(read) => {
                if context
                    .contents
                    .get(&target)
                    .is_some_and(|seen| *seen != sha256_hex(&read.bytes))
                {
                    return fail(
                        &target,
                        "changed since start read it; read it again before changing it",
                    );
                }
                current = Some(read);
            }
            Err(message) => return fail(&target, &message),
        }
    } else if !file.parent().is_some_and(Path::is_dir) {
        return fail(&target, "its directory does not exist");
    }
    let mut replacements = None;
    let updated = if tool == "edit" {
        let text = &current.as_ref().expect("edit read the file").text;
        let old = args.old_string.as_deref().unwrap_or("");
        let new = args.new_string.as_deref().unwrap_or("");
        if old.is_empty() {
            return fail(&target, "old_string is empty");
        }
        if old == new {
            return fail(&target, "old_string and new_string are the same");
        }
        let count = text.matches(old).count();
        if count == 0 {
            return fail(&target, "old_string was not found; nothing changed");
        }
        if count > 1 && !args.replace_all {
            return fail(
                &target,
                &format!(
                    "old_string occurs {} times; give more surrounding text or set replace_all; nothing changed",
                    count
                ),
            );
        }
        replacements = Some(if args.replace_all { count } else { 1 });
        if args.replace_all {
            text.replace(old, new)
        } else {
            text.replacen(old, new, 1)
        }
    } else {
        args.content.clone().unwrap_or_default()
    };
    let expected = updated.into_bytes();
    if expected.len() as u64 > max_file_bytes {
        return fail(
            &target,
            &format!(
                "the new text has {} bytes; START_FORMAL_AI_MAX_FILE_BYTES is {}",
                expected.len(),
                max_file_bytes
            ),
        );
    }
    let permissions = current.as_ref().map(|read| read.permissions.clone());
    if let Err(error) = write_atomically(&file, &expected, permissions) {
        return fail(&target, &format!("failed ({})", error));
    }
    let readback = fs::read(&file).unwrap_or_default();
    let verified = readback == expected;
    let sha = sha256_hex(&readback);
    context.observed.insert(target.clone());
    context.contents.insert(target.clone(), sha.clone());
    FileReceipt {
        exit_code: 0,
        result: String::new(),
        bytes: Some(expected.len() as u64),
        sha256: Some(sha),
        previous_sha256: current.as_ref().map(|read| sha256_hex(&read.bytes)),
        replacements,
        verification: Some(Verification {
            verified,
            detail: if verified {
                format!(
                    "readback confirmed {} {} ({} bytes)",
                    tool,
                    target,
                    expected.len()
                )
            } else {
                format!("readback of {} differs from the written text", target)
            },
        }),
        ..FileReceipt::default()
    }
}

#[cfg(test)]
#[path = "formal_ai_files_cases.rs"]
mod formal_ai_files_cases;
