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
//!   START_FORMAL_AI_MAX_FILE_BYTES, as the numbered frame Formal AI decodes
//!   back to that text (#261); it observes the file for later changes.
//! - edit: replaces one literal occurrence of old_string (or every one with
//!   replace_all) in a file read before, atomically, then reads it back.
//! - write: replaces an observed file, or creates one in an observed
//!   directory, atomically, then reads it back.
//!
//! Paths follow the bash tool's workspace policy (no absolute, escaping or
//! symlinked-out paths), edit and write need START_FORMAL_AI_EFFECTS=
//! workspace-write and an earlier observation of the target, and a file that
//! changed since start read it is not overwritten.
//!
//! Bounded typed source edits (issue #261): a change to an existing file is
//! bound to the complete bytes the read tool returned for it in this task
//! (listing it or `cat` is not enough), applied to exactly the matched regions
//! of those bytes, guarded against a change of the target until the new file
//! takes its place, and verified by reading it back: every matched region now
//! holds new_string and every other byte is unchanged and in place. The
//! mutation receipt (preimage, postimage and byte offsets of the matches) is
//! kept in the evidence and returned to Formal AI.

use std::fs::{self, OpenOptions, Permissions};
use std::io::{Read, Write};
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
            "Replace the literal text old_string with new_string in one file read completely with read in this task, unchanged since; old_string must occur exactly once unless replace_all is true. Nothing else in the file changes.",
            json!({
                "path": path_schema(),
                "old_string": { "type": "string" },
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean" },
            }),
            json!(["path", "old_string", "new_string"]),
        ),
        _ => (
            "Write the whole text of one file: a file read completely with read in this task, unchanged since, or a new file in a directory listed before.",
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

const LINK_APPEARED: &str =
    "is a symbolic link that appeared after start resolved the path; nothing changed";

/// `symlink_metadata` of `file`, or None when it does not exist.
fn lstat_or_none(file: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(file) {
        Ok(meta) => Ok(Some(meta)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(format!("cannot inspect the file ({})", error)),
    }
}

fn missing(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ENOTDIR) {
        return true;
    }
    error.kind() == std::io::ErrorKind::NotFound
}

/// Open the final path component without following a symbolic link: the
/// policy resolved the target, so a link there now is a swapped path (#261).
fn open_no_follow(file: &Path) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(file)
}

/// The exact bytes of a regular workspace file, read through one handle
/// opened without following a symbolic link.
fn read_bytes(file: &Path, max_file_bytes: u64) -> Result<(Vec<u8>, Permissions), String> {
    if lstat_or_none(file)?.is_some_and(|meta| meta.file_type().is_symlink()) {
        return Err(LINK_APPEARED.to_string());
    }
    let mut handle = open_no_follow(file).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return LINK_APPEARED.to_string();
        }
        if error.kind() == std::io::ErrorKind::NotFound {
            "no such file".to_string()
        } else {
            format!("cannot read the file ({})", error)
        }
    })?;
    let meta = handle
        .metadata()
        .map_err(|error| format!("cannot read the file ({})", error))?;
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
    let mut bytes = Vec::new();
    // One byte past the bound is enough to see the file grew beyond it.
    (&mut handle)
        .take(max_file_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read the file ({})", error))?;
    if bytes.len() as u64 > max_file_bytes {
        return Err(too_large(bytes.len() as u64));
    }
    Ok((bytes, meta.permissions()))
}

/// Text of a regular workspace file, refusing what read could not return exactly.
fn read_text(file: &Path, max_file_bytes: u64) -> Result<FileText, String> {
    let (bytes, permissions) = read_bytes(file, max_file_bytes)?;
    match std::str::from_utf8(&bytes) {
        Ok(text) if !text.contains('\0') => Ok(FileText {
            text: text.to_string(),
            bytes: bytes.clone(),
            permissions,
        }),
        _ => Err("is not UTF-8 text".to_string()),
    }
}

/// Why a change did not complete: a message of start's own, or an I/O error.
enum WriteError {
    Tool(String),
    Io(std::io::Error),
}

impl WriteError {
    fn message(&self) -> String {
        match self {
            WriteError::Tool(message) => message.clone(),
            WriteError::Io(error) => format!("failed ({})", error),
        }
    }
}

impl From<std::io::Error> for WriteError {
    fn from(error: std::io::Error) -> Self {
        WriteError::Io(error)
    }
}

/// Replace `file` by `content` through a temporary sibling. Just before the
/// temporary file takes the target's place, `guard()` checks that the target
/// still holds the preimage start bound the change to; a new file is linked in
/// place, so a file that appeared meanwhile is never overwritten.
fn write_atomically(
    file: &Path,
    content: &[u8],
    permissions: Option<Permissions>,
    guard: &dyn Fn() -> Result<(), String>,
    create: bool,
) -> Result<(), WriteError> {
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
        guard().map_err(WriteError::Tool)?;
        if create {
            fs::hard_link(&temporary, file).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    WriteError::Tool(
                        "was created while start was writing it; nothing changed".to_string(),
                    )
                } else {
                    WriteError::Io(error)
                }
            })
        } else {
            fs::rename(&temporary, file).map_err(WriteError::Io)
        }
    })();
    let _ = fs::remove_file(&temporary);
    result
}

/// One matched region of a mutation receipt, in bytes of the preimage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Match {
    pub offset: usize,
    pub old_bytes: usize,
    pub new_bytes: usize,
}

impl Match {
    fn to_json(self) -> Value {
        json!({ "offset": self.offset, "oldBytes": self.old_bytes, "newBytes": self.new_bytes })
    }
}

/// Byte-level splice of `preimage`: each match's old bytes become `new_bytes`.
fn splice(preimage: &[u8], matches: &[Match], new_bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(preimage.len());
    let mut cursor = 0;
    for found in matches {
        out.extend_from_slice(&preimage[cursor..found.offset]);
        out.extend_from_slice(new_bytes);
        cursor = found.offset + found.old_bytes;
    }
    out.extend_from_slice(&preimage[cursor..]);
    out
}

/// Check a readback against the mutation receipt, independently of how the
/// new text was computed: every matched preimage region held exactly the old
/// bytes, every other preimage byte is unchanged and in place, every replaced
/// region holds exactly the new bytes, and nothing else was added.
pub fn verify_mutation(
    preimage: &[u8],
    readback: &[u8],
    matches: &[Match],
    old_bytes: &[u8],
    new_bytes: &[u8],
) -> Verification {
    let bad = |detail: String| Verification {
        verified: false,
        detail,
    };
    if matches.is_empty() {
        return bad("the mutation receipt has no matched region".to_string());
    }
    let expected_len = (preimage.len() as i128)
        + (matches.len() as i128) * (new_bytes.len() as i128 - old_bytes.len() as i128);
    if readback.len() as i128 != expected_len {
        return bad(format!(
            "readback has {} bytes, expected {}",
            readback.len(),
            expected_len
        ));
    }
    let mut before = 0;
    let mut after = 0;
    for (index, found) in matches.iter().enumerate() {
        let number = index + 1;
        if found.offset < before
            || found.old_bytes != old_bytes.len()
            || found.new_bytes != new_bytes.len()
            || found.offset + found.old_bytes > preimage.len()
        {
            return bad(format!(
                "match {} of the mutation receipt is malformed",
                number
            ));
        }
        let keep = found.offset - before;
        if readback.get(after..after + keep) != Some(&preimage[before..found.offset]) {
            return bad(format!("bytes before match {} changed", number));
        }
        after += keep;
        if &preimage[found.offset..found.offset + found.old_bytes] != old_bytes {
            return bad(format!(
                "match {} did not hold old_string in the preimage",
                number
            ));
        }
        if readback.get(after..after + new_bytes.len()) != Some(new_bytes) {
            return bad(format!(
                "match {} does not hold new_string after the change",
                number
            ));
        }
        before = found.offset + found.old_bytes;
        after += new_bytes.len();
    }
    if readback.get(after..) != Some(&preimage[before..]) {
        return bad("bytes after the last match changed".to_string());
    }
    Verification {
        verified: true,
        detail: format!(
            "{} replacement(s); every other byte unchanged",
            matches.len()
        ),
    }
}

fn digest(bytes: &[u8]) -> Value {
    json!({ "sha256": sha256_hex(bytes), "bytes": bytes.len() })
}

/// The complete text of a read as the numbered frame Formal AI binds as a
/// whole-file Read (#261): one `NNNNN| line` per `\n`-separated line and a
/// trailer with the line count. Formal AI decodes it back to exactly `text`
/// (lines joined with `\n`, so a missing or present final newline, CR bytes
/// and Unicode survive); its OpenAI-compatible request parser drops any other
/// metadata on a tool message, so the frame is the only binding it accepts.
pub fn read_frame(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let width = lines.len().to_string().len().max(5);
    let numbered: Vec<String> = lines
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{:0width$}| {}", index + 1, line, width = width))
        .collect();
    format!(
        "<file>\n{}\n\n(End of file - total {} lines)\n</file>",
        numbered.join("\n"),
        lines.len()
    )
}

/// The exact text a read_frame() result frames, or None when it is not one.
pub fn read_frame_text(frame: &str) -> Option<String> {
    const OPEN: &str = "<file>\n";
    const MARKER: &str = "\n\n(End of file - total ";
    if !frame.starts_with(OPEN) || !frame.ends_with("</file>") {
        return None;
    }
    let at = frame.rfind(MARKER)?;
    if at < OPEN.len() {
        return None;
    }
    let lines: Vec<&str> = frame[OPEN.len()..at].split('\n').collect();
    let count: usize = frame[at + MARKER.len()..]
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    if count != lines.len() {
        return None;
    }
    let mut out = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        let split = line.find("| ")?;
        if line[..split].parse::<usize>().ok()? != index + 1 {
            return None;
        }
        out.push(&line[split + 2..]);
    }
    Some(out.join("\n"))
}

/// Whether a tool result of the conversation already contained `text`, as
/// sent or as the file text of a read frame (whose lines carry numbers): an
/// answer that only echoes file data back is not Formal AI's own (#261).
pub fn echoed_by_tool(text: &str, messages: &[Value]) -> bool {
    messages.iter().any(|m| {
        if m["role"] != "tool" {
            return false;
        }
        let content = match &m["content"] {
            Value::String(content) => content.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        content.contains(text) || read_frame_text(&content).is_some_and(|t| t.contains(text))
    })
}

/// What an approved file call did.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FileReceipt {
    pub exit_code: i32,
    /// Tool message for Formal AI: the numbered frame of a read, the JSON
    /// receipt of a change, a JSON error otherwise.
    pub result: String,
    /// Text a read returned.
    pub text: Option<String>,
    pub error: Option<String>,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub previous_sha256: Option<String>,
    pub replacements: Option<usize>,
    /// Mutation receipt: tool, target, preimage, postimage, matches?, readback?
    pub mutation: Option<Value>,
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
        if let Some(mutation) = &self.mutation {
            out["mutation"] = mutation.clone();
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

/// The tool result Formal AI receives for a change: its receipt, as JSON.
fn change_result(receipt: &Value, verified: bool) -> String {
    let mut out = json!({
        "ok": verified,
        "path": receipt["target"],
        "tool": receipt["tool"],
        "preimage": receipt["preimage"],
        "postimage": receipt["postimage"],
        "verified": verified,
    });
    if let Some(matches) = receipt["matches"].as_array() {
        out["replacements"] = json!(matches.len());
    }
    out.to_string()
}

/// Test hooks: run just before the guard and just before the readback.
#[derive(Default)]
pub struct FileHooks<'a> {
    pub before_replace: Option<&'a dyn Fn(&Path)>,
    pub after_replace: Option<&'a dyn Fn(&Path)>,
}

/// Run an approved file tool call.
///
/// A change is bound to the complete bytes of the target that this task last
/// read with the read tool (or wrote and verified): `context.contents` maps
/// paths to their SHA-256. The edit is applied to those bytes only, the target
/// is checked to still hold them just before the new file takes its place,
/// and the readback is verified byte for byte against the mutation receipt
/// (edit) or the whole intended text (write).
pub fn run_file_call(
    tool: &str,
    args: &FileArgs,
    decision: &FileDecision,
    context: &mut PolicyContext,
    max_file_bytes: u64,
) -> FileReceipt {
    run_file_call_with(
        tool,
        args,
        decision,
        context,
        max_file_bytes,
        &FileHooks::default(),
    )
}

/// run_file_call() with test hooks.
pub fn run_file_call_with(
    tool: &str,
    args: &FileArgs,
    decision: &FileDecision,
    context: &mut PolicyContext,
    max_file_bytes: u64,
    hooks: &FileHooks<'_>,
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
                    result: read_frame(&read.text),
                    text: Some(read.text),
                    bytes: Some(read.bytes.len() as u64),
                    sha256: Some(sha),
                    ..FileReceipt::default()
                }
            }
            Err(message) => fail(&target, &message),
        };
    }
    let existing = match lstat_or_none(&file) {
        Ok(existing) => existing,
        Err(message) => return fail(&target, &message),
    };
    if existing
        .as_ref()
        .is_some_and(|meta| meta.file_type().is_symlink())
    {
        return fail(
            &target,
            "is a symbolic link start cannot resolve inside the working directory; nothing changed",
        );
    }
    let mut current = None;
    if tool == "edit" || existing.is_some() {
        let Some(seen) = context.contents.get(&target).cloned() else {
            return fail(
                &target,
                "was not read completely with the read tool in this task; read it before changing it; nothing changed",
            );
        };
        match read_text(&file, max_file_bytes) {
            Ok(read) if seen == sha256_hex(&read.bytes) => current = Some(read),
            Ok(_) => return fail(
                &target,
                "changed since start read it; read it again before changing it; nothing changed",
            ),
            Err(message) => return fail(&target, &message),
        }
    } else if !file.parent().is_some_and(Path::is_dir) {
        return fail(&target, "its directory does not exist");
    }
    let mut matches: Option<Vec<Match>> = None;
    let old = args.old_string.as_deref().unwrap_or("");
    let new = args.new_string.as_deref().unwrap_or("");
    let expected = if tool == "edit" {
        let read = current.as_ref().expect("edit read the file");
        if old.is_empty() {
            return fail(&target, "old_string is empty; nothing changed");
        }
        if old == new {
            return fail(
                &target,
                "old_string and new_string are the same; nothing changed",
            );
        }
        // Rust strings are always valid Unicode: a lone surrogate never
        // reaches here (its JSON arguments do not parse).
        let found: Vec<usize> = read.text.match_indices(old).map(|(at, _)| at).collect();
        if found.is_empty() {
            return fail(&target, "old_string was not found; nothing changed");
        }
        if found.len() > 1 && !args.replace_all {
            return fail(
                &target,
                &format!(
                    "old_string occurs {} times; give more surrounding text or set replace_all; nothing changed",
                    found.len()
                ),
            );
        }
        let chosen = if args.replace_all {
            &found[..]
        } else {
            &found[..1]
        };
        let list: Vec<Match> = chosen
            .iter()
            .map(|offset| Match {
                offset: *offset,
                old_bytes: old.len(),
                new_bytes: new.len(),
            })
            .collect();
        let spliced = splice(&read.bytes, &list, new.as_bytes());
        // The byte splice and the text replacement must agree exactly.
        let text = if args.replace_all {
            read.text.replace(old, new)
        } else {
            read.text.replacen(old, new, 1)
        };
        if spliced != text.as_bytes() {
            return fail(
                &target,
                "the replacement does not map to whole UTF-8 characters; nothing changed",
            );
        }
        matches = Some(list);
        spliced
    } else {
        args.content.clone().unwrap_or_default().into_bytes()
    };
    if expected.len() as u64 > max_file_bytes {
        return fail(
            &target,
            &format!(
                "the new text has {} bytes; START_FORMAL_AI_MAX_FILE_BYTES is {}; nothing changed",
                expected.len(),
                max_file_bytes
            ),
        );
    }
    let mut receipt = json!({
        "tool": tool,
        "target": target,
        "preimage": current.as_ref().map(|read| digest(&read.bytes)),
        "postimage": digest(&expected),
    });
    if let Some(list) = &matches {
        receipt["matches"] = json!(list.iter().map(|m| m.to_json()).collect::<Vec<_>>());
    }
    let preimage = current.as_ref().map(|read| read.bytes.as_slice());
    let guard = || {
        if let Some(hook) = hooks.before_replace {
            hook(&file);
        }
        if still_holds(&file, preimage, max_file_bytes) {
            Ok(())
        } else if preimage.is_some() {
            Err("changed while start was changing it; read it again; nothing changed".to_string())
        } else {
            Err("was created while start was writing it; nothing changed".to_string())
        }
    };
    let permissions = current.as_ref().map(|read| read.permissions.clone());
    if let Err(error) = write_atomically(&file, &expected, permissions, &guard, current.is_none()) {
        let message = error.message();
        // The change did not complete: say truthfully whether the target
        // still holds its preimage, and forget a preimage that no longer holds.
        let intact = still_holds(&file, preimage, max_file_bytes);
        if !intact {
            context.contents.remove(&target);
        }
        let message = if intact || message.ends_with("nothing changed") {
            format!(
                "{}; nothing changed",
                message.trim_end_matches("; nothing changed")
            )
        } else {
            format!("{}; the file may have changed; read it again", message)
        };
        return FileReceipt {
            mutation: Some(receipt),
            ..fail(&target, &message)
        };
    }
    context.observed.insert(target.clone());
    let previous_sha256 = preimage.map(sha256_hex);
    let replacements = matches.as_ref().map(Vec::len);
    if let Some(hook) = hooks.after_replace {
        hook(&file);
    }
    let readback = match read_bytes(&file, max_file_bytes) {
        Ok((bytes, _)) => bytes,
        Err(message) => {
            context.contents.remove(&target);
            return FileReceipt {
                exit_code: 0,
                result: change_result(&receipt, false),
                bytes: Some(expected.len() as u64),
                previous_sha256,
                replacements,
                mutation: Some(receipt),
                verification: Some(Verification {
                    verified: false,
                    detail: format!("readback of {} failed ({})", target, message),
                }),
                ..FileReceipt::default()
            };
        }
    };
    let check = match (&matches, preimage) {
        (Some(list), Some(preimage)) => {
            verify_mutation(preimage, &readback, list, old.as_bytes(), new.as_bytes())
        }
        _ => Verification {
            verified: true,
            detail: "whole text".to_string(),
        },
    };
    let verified = check.verified && readback == expected;
    receipt["readback"] = digest(&readback);
    let sha = sha256_hex(&readback);
    if verified {
        context.contents.insert(target.clone(), sha.clone());
    } else {
        context.contents.remove(&target);
    }
    FileReceipt {
        exit_code: 0,
        result: change_result(&receipt, verified),
        bytes: Some(expected.len() as u64),
        sha256: Some(sha),
        previous_sha256,
        replacements,
        mutation: Some(receipt),
        verification: Some(Verification {
            verified,
            detail: if verified {
                format!(
                    "readback confirmed {} {} ({} bytes; {})",
                    tool,
                    target,
                    expected.len(),
                    check.detail
                )
            } else if check.verified {
                format!("readback of {} differs from the intended text", target)
            } else {
                format!(
                    "readback of {} differs from the intended text ({})",
                    target, check.detail
                )
            },
        }),
        ..FileReceipt::default()
    }
}

/// Whether `file` still holds the bound preimage (or is still absent).
fn still_holds(file: &Path, preimage: Option<&[u8]>, max_file_bytes: u64) -> bool {
    match (lstat_or_none(file), preimage) {
        (Ok(None), None) => true,
        (Ok(Some(meta)), Some(preimage)) if !meta.file_type().is_symlink() => {
            read_bytes(file, max_file_bytes).is_ok_and(|(bytes, _)| bytes == preimage)
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "formal_ai_files_cases.rs"]
mod formal_ai_files_cases;
