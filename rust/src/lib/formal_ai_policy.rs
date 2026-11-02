//! Bounds and effect policy of the experimental `--use-formal-ai` mode
//! (issue #255). Mirrors js/src/lib/formal-ai-policy.js.
//!
//! Formal AI owns the interpretation of a natural-language request and picks
//! the tool calls; start owns the permission to run them. Every tool call is a
//! POSIX command line that start tokenizes itself and runs as an argv vector,
//! never through a shell, so a call that needs shell syntax (pipes, redirects,
//! substitutions, globs, variables) is refused instead of being interpreted.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde_json::{json, Value};

/// Request text or option combination rejected.
pub const EXIT_USAGE: i32 = 64;
/// Formal AI did not understand the task or reported a capability gap.
pub const EXIT_UNSUPPORTED: i32 = 65;
/// No qualified Formal AI runtime could be resolved.
pub const EXIT_UNAVAILABLE: i32 = 69;
/// Malformed or 5xx response, unknown tool or unverified effect.
pub const EXIT_PROTOCOL: i32 = 70;
/// A tool call was refused by the effect policy.
pub const EXIT_REFUSED: i32 = 77;
/// Invalid START_FORMAL_AI_* bound.
pub const EXIT_CONFIG: i32 = 78;
/// Step, tool, time or retry budget exhausted.
pub const EXIT_BUDGET: i32 = 124;

pub const EFFECT_MODES: [&str; 2] = ["read-only", "workspace-write"];

/// One START_FORMAL_AI_* bound: environment variable, default and range.
pub struct BoundSpec {
    pub key: &'static str,
    pub env: &'static str,
    pub value: u64,
    pub min: u64,
    pub max: Option<u64>,
}

pub const BOUND_DEFAULTS: [BoundSpec; 10] = [
    BoundSpec {
        key: "maxSteps",
        env: "START_FORMAL_AI_MAX_STEPS",
        value: 8,
        min: 1,
        max: Some(64),
    },
    BoundSpec {
        key: "maxRetries",
        env: "START_FORMAL_AI_MAX_RETRIES",
        value: 1,
        min: 0,
        max: Some(5),
    },
    BoundSpec {
        key: "timeoutMs",
        env: "START_FORMAL_AI_TIMEOUT_MS",
        value: 120_000,
        min: 1,
        max: None,
    },
    BoundSpec {
        key: "toolTimeoutMs",
        env: "START_FORMAL_AI_TOOL_TIMEOUT_MS",
        value: 30_000,
        min: 1,
        max: None,
    },
    BoundSpec {
        key: "startupTimeoutMs",
        env: "START_FORMAL_AI_STARTUP_TIMEOUT_MS",
        value: 30_000,
        min: 1,
        max: None,
    },
    BoundSpec {
        key: "maxOutputBytes",
        env: "START_FORMAL_AI_MAX_OUTPUT_BYTES",
        value: 64 * 1024,
        min: 1,
        max: Some(16 * 1024 * 1024),
    },
    BoundSpec {
        key: "maxFileBytes",
        env: "START_FORMAL_AI_MAX_FILE_BYTES",
        value: 1024 * 1024,
        min: 1,
        max: Some(16 * 1024 * 1024),
    },
    BoundSpec {
        key: "maxRequestChars",
        env: "START_FORMAL_AI_MAX_REQUEST_CHARS",
        value: 4096,
        min: 1,
        max: None,
    },
    BoundSpec {
        key: "maxMemoryMb",
        env: "START_FORMAL_AI_MAX_MEMORY_MB",
        value: 1024,
        min: 1,
        max: None,
    },
    BoundSpec {
        key: "maxFingerprintEntries",
        env: "START_FORMAL_AI_MAX_FINGERPRINT_ENTRIES",
        value: 5000,
        min: 1,
        max: None,
    },
];

/// Resolved bounds of one run.
#[derive(Debug, Clone, PartialEq)]
pub struct Bounds {
    pub max_steps: u64,
    pub max_retries: u64,
    pub timeout_ms: u64,
    pub tool_timeout_ms: u64,
    pub startup_timeout_ms: u64,
    pub max_output_bytes: u64,
    /// Largest file the read, edit and write tools handle (issue #258).
    pub max_file_bytes: u64,
    pub max_request_chars: u64,
    pub max_memory_mb: u64,
    pub max_fingerprint_entries: u64,
    pub effects: String,
}

impl Default for Bounds {
    fn default() -> Self {
        resolve_bounds_with(|_| None).expect("defaults are valid")
    }
}

impl Bounds {
    /// The bounds as the evidence records them (same keys as JavaScript).
    pub fn to_json(&self) -> Value {
        json!({
            "maxSteps": self.max_steps,
            "maxRetries": self.max_retries,
            "timeoutMs": self.timeout_ms,
            "toolTimeoutMs": self.tool_timeout_ms,
            "startupTimeoutMs": self.startup_timeout_ms,
            "maxOutputBytes": self.max_output_bytes,
            "maxFileBytes": self.max_file_bytes,
            "maxRequestChars": self.max_request_chars,
            "maxMemoryMb": self.max_memory_mb,
            "maxFingerprintEntries": self.max_fingerprint_entries,
            "effects": self.effects,
        })
    }
}

/// Resolve the bounds from the process environment.
pub fn resolve_bounds() -> Result<Bounds, String> {
    resolve_bounds_with(|name| std::env::var(name).ok())
}

/// Resolve the bounds of one run from START_FORMAL_AI_* variables read
/// through `get`. An invalid value is an error (exit status EXIT_CONFIG).
pub fn resolve_bounds_with(get: impl Fn(&str) -> Option<String>) -> Result<Bounds, String> {
    let mut values = BTreeMap::new();
    for spec in BOUND_DEFAULTS.iter() {
        let raw = get(spec.env).unwrap_or_default();
        if raw.is_empty() {
            values.insert(spec.key, spec.value);
            continue;
        }
        let trimmed = raw.trim();
        let parsed = if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
            trimmed.parse::<u64>().ok()
        } else {
            None
        };
        match parsed {
            Some(value) if value >= spec.min && spec.max.is_none_or(|max| value <= max) => {
                values.insert(spec.key, value);
            }
            _ => {
                let max = spec
                    .max
                    .map_or_else(|| "any".to_string(), |max| max.to_string());
                return Err(format!(
                    "{} must be an integer from {} to {}, got \"{}\"",
                    spec.env, spec.min, max, raw
                ));
            }
        }
    }
    let effects = get("START_FORMAL_AI_EFFECTS")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "read-only".to_string())
        .trim()
        .to_string();
    if !EFFECT_MODES.contains(&effects.as_str()) {
        return Err(format!(
            "START_FORMAL_AI_EFFECTS must be one of {}, got \"{}\"",
            EFFECT_MODES.join(", "),
            effects
        ));
    }
    Ok(Bounds {
        max_steps: values["maxSteps"],
        max_retries: values["maxRetries"],
        timeout_ms: values["timeoutMs"],
        tool_timeout_ms: values["toolTimeoutMs"],
        startup_timeout_ms: values["startupTimeoutMs"],
        max_output_bytes: values["maxOutputBytes"],
        max_file_bytes: values["maxFileBytes"],
        max_request_chars: values["maxRequestChars"],
        max_memory_mb: values["maxMemoryMb"],
        max_fingerprint_entries: values["maxFingerprintEntries"],
        effects,
    })
}

/// Words of a command line and the shell syntax it would have needed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Tokenized {
    pub tokens: Vec<String>,
    pub problems: Vec<String>,
}

/// Split a command line with POSIX quoting rules. Characters that would make
/// a shell do more than split words are reported instead of honoured.
pub fn tokenize_command(line: &str) -> Tokenized {
    let chars: Vec<char> = line.chars().collect();
    let mut tokens = Vec::new();
    let mut problems: Vec<String> = Vec::new();
    let mut add = |problem: String| {
        if !problems.contains(&problem) {
            problems.push(problem);
        }
    };
    let mut current: Option<String> = None;
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if quote == Some('\'') {
            if ch == '\'' {
                quote = None;
            } else {
                current.get_or_insert_with(String::new).push(ch);
            }
            i += 1;
            continue;
        }
        if quote == Some('"') {
            if ch == '"' {
                quote = None;
            } else if ch == '\\' && i + 1 < chars.len() && "\"\\$`".contains(chars[i + 1]) {
                i += 1;
                current.get_or_insert_with(String::new).push(chars[i]);
            } else {
                if ch == '$' || ch == '`' {
                    add(format!("expansion \"{}\"", ch));
                }
                current.get_or_insert_with(String::new).push(ch);
            }
            i += 1;
            continue;
        }
        if ch == ' ' || ch == '\t' {
            if let Some(token) = current.take() {
                tokens.push(token);
            }
            i += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.get_or_insert_with(String::new);
            i += 1;
            continue;
        }
        if ch == '\\' {
            if i + 1 < chars.len() && chars[i + 1] != '\n' {
                i += 1;
                current.get_or_insert_with(String::new).push(chars[i]);
                i += 1;
                continue;
            }
            add("line continuation".to_string());
            i += 1;
            continue;
        }
        if "\n\r;&|<>()$`".contains(ch) {
            let shown = if ch == '\n' {
                "\\n".to_string()
            } else {
                ch.to_string()
            };
            add(format!("shell operator \"{}\"", shown));
        } else if "*?[]{}".contains(ch) {
            add(format!("unquoted pattern \"{}\"", ch));
        } else if ch == '~' && current.is_none() {
            add("home directory expansion \"~\"".to_string());
        } else if ch == '#' && current.is_none() {
            add("comment \"#\"".to_string());
        }
        current.get_or_insert_with(String::new).push(ch);
        i += 1;
    }
    if quote.is_some() {
        add("unterminated quote".to_string());
    }
    if let Some(token) = current {
        tokens.push(token);
    }
    Tokenized { tokens, problems }
}

pub const READ_PROGRAMS: [&str; 24] = [
    "basename",
    "cat",
    "cmp",
    "diff",
    "dirname",
    "du",
    "file",
    "find",
    "git",
    "grep",
    "head",
    "ls",
    "md5sum",
    "pwd",
    "readlink",
    "realpath",
    "sha256sum",
    "sort",
    "stat",
    "tail",
    "test",
    "tree",
    "uniq",
    "wc",
];
pub const WRITE_PROGRAMS: [&str; 6] = ["cp", "mkdir", "mv", "rm", "rmdir", "touch"];
const LISTING_PROGRAMS: [&str; 4] = ["ls", "find", "tree", "du"];
const GIT_SUBCOMMANDS: [&str; 7] = [
    "branch",
    "diff",
    "log",
    "ls-files",
    "rev-parse",
    "show",
    "status",
];
const GIT_BRANCH_FLAGS: [&str; 6] = ["-a", "-r", "-v", "-vv", "--list", "--show-current"];

/// Flags that turn an otherwise read-only program into a writer or waiter.
fn forbidden_flags(program: &str) -> Option<Regex> {
    let pattern = match program {
        "find" => r"^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$",
        "sort" | "tree" => r"^(-o.*|--output.*)$",
        "file" => r"^(-C|--compile)$",
        "tail" => r"^(-f|-F|--follow.*|--retry)$",
        "git" => r"^(--output.*|--ext-diff|-c|--exec-path.*|--git-dir.*|--work-tree.*)$",
        "rm" => r"^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--no-preserve-root)$",
        "cp" => r"^(-[a-zA-Z]*[l][a-zA-Z]*|--link|-s|--symbolic-link)$",
        _ => return None,
    };
    Regex::new(pattern).ok()
}

/// Lexically normalize a path (`.` and `..` resolved without the filesystem).
fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// Real path of `target`, resolving its nearest existing ancestor.
fn real_target(target: &Path) -> PathBuf {
    let mut existing = target.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => return target.to_path_buf(),
        }
    }
    let mut resolved = fs::canonicalize(&existing).unwrap_or(existing);
    for name in rest.iter().rev() {
        resolved.push(name);
    }
    resolved
}

/// Path-like operands of a call (values of `--opt=value` included).
pub fn operands(tokens: &[String]) -> Vec<String> {
    let mut values = Vec::new();
    for token in tokens.iter().skip(1) {
        if token.starts_with('-') {
            if let Some(eq) = token.find('=') {
                if eq > 0 && token.starts_with("--") {
                    values.push(token[eq + 1..].to_string());
                }
            }
            continue;
        }
        values.push(token.clone());
    }
    values
}

/// Normalized workspace-relative path of an operand, or None outside it.
pub fn workspace_path(cwd: &Path, operand: &str) -> Option<String> {
    let root = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let resolved = real_target(&normalize(&cwd.join(operand)));
    let relative = resolved.strip_prefix(&root).ok()?;
    let text = relative.to_string_lossy().to_string();
    Some(if text.is_empty() {
        ".".to_string()
    } else {
        text
    })
}

/// Directory of a workspace-relative path ("." at the top).
pub fn parent_of(target: &str) -> String {
    match Path::new(target).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_string_lossy().to_string(),
        _ => ".".to_string(),
    }
}

/// What a read observed, so a later change may name it.
#[derive(Debug, Clone, Default)]
pub struct PolicyContext {
    pub cwd: PathBuf,
    pub effects: String,
    pub observed: BTreeSet<String>,
    pub observed_dirs: BTreeSet<String>,
    /// SHA-256 of each file as start last read or wrote it (issue #258).
    pub contents: BTreeMap<String, String>,
}

impl PolicyContext {
    pub fn new(cwd: &Path, effects: &str) -> Self {
        Self {
            cwd: cwd.to_path_buf(),
            effects: effects.to_string(),
            ..Self::default()
        }
    }
}

/// Decision about one tool call.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Decision {
    pub allowed: bool,
    pub reason: Option<String>,
    pub tokens: Vec<String>,
    /// `read` or `write` when allowed
    pub kind: Option<&'static str>,
    pub targets: Vec<String>,
}

fn refuse(reason: String, tokens: &[String]) -> Decision {
    Decision {
        allowed: false,
        reason: Some(reason),
        tokens: tokens.to_vec(),
        ..Decision::default()
    }
}

/// Decide whether a tool call may run.
pub fn evaluate_command(line: &str, context: &PolicyContext) -> Decision {
    let Tokenized { tokens, problems } = tokenize_command(line);
    if !problems.is_empty() {
        return refuse(
            format!(
                "needs shell syntax start does not run: {}",
                problems.join(", ")
            ),
            &tokens,
        );
    }
    let Some(program) = tokens.first().cloned() else {
        return refuse("empty command".to_string(), &tokens);
    };
    let is_write = WRITE_PROGRAMS.contains(&program.as_str());
    if !READ_PROGRAMS.contains(&program.as_str()) && !is_write {
        return refuse(
            format!("program \"{}\" is not in the supported tool set", program),
            &tokens,
        );
    }
    if is_write && context.effects != "workspace-write" {
        return refuse(
            format!(
                "\"{}\" changes files; the effect mode is read-only (set START_FORMAL_AI_EFFECTS=workspace-write to allow workspace changes)",
                program
            ),
            &tokens,
        );
    }
    if let Some(forbidden) = forbidden_flags(&program) {
        if let Some(flag) = tokens.iter().skip(1).find(|t| forbidden.is_match(t)) {
            return refuse(
                format!("option \"{}\" of {} is not allowed", flag, program),
                &tokens,
            );
        }
    }
    if program == "git" {
        let sub = tokens.get(1).cloned().unwrap_or_default();
        if !GIT_SUBCOMMANDS.contains(&sub.as_str()) {
            return refuse(
                format!("git subcommand \"{}\" is not read-only", sub),
                &tokens,
            );
        }
        if sub == "branch"
            && tokens
                .iter()
                .skip(2)
                .any(|t| !GIT_BRANCH_FLAGS.contains(&t.as_str()))
        {
            return refuse("git branch may only list branches".to_string(), &tokens);
        }
    }
    let mut targets = Vec::new();
    for operand in operands(&tokens) {
        if operand.starts_with('~') {
            return refuse(
                format!("\"{}\" is outside the working directory", operand),
                &tokens,
            );
        }
        // Absolute, escaping and symlinked-out operands are refused: reads and
        // changes stay inside the working directory.
        match workspace_path(&context.cwd, &operand) {
            Some(relative) => targets.push(relative),
            None => {
                return refuse(
                    format!("\"{}\" is outside the working directory", operand),
                    &tokens,
                )
            }
        }
    }
    if is_write {
        if targets.is_empty() {
            return refuse(format!("{} needs an explicit target", program), &tokens);
        }
        let unobserved: Vec<String> = targets
            .iter()
            .filter(|t| {
                t.as_str() == "."
                    || !(context.observed.contains(*t)
                        || context.observed_dirs.contains(&parent_of(t)))
            })
            .map(|t| format!("\"{}\"", t))
            .collect();
        if !unobserved.is_empty() {
            return refuse(
                format!(
                    "target {} was not observed before the change",
                    unobserved.join(", ")
                ),
                &tokens,
            );
        }
    }
    Decision {
        allowed: true,
        reason: None,
        tokens,
        kind: Some(if is_write { "write" } else { "read" }),
        targets,
    }
}

/// Remember what a read call observed, so a later change may name it.
pub fn record_observation(decision: &Decision, context: &mut PolicyContext) {
    for target in &decision.targets {
        context.observed.insert(target.clone());
    }
    let listing = decision
        .tokens
        .first()
        .is_some_and(|program| LISTING_PROGRAMS.contains(&program.as_str()));
    if listing {
        if decision.targets.is_empty() {
            context.observed_dirs.insert(".".to_string());
        }
        for target in &decision.targets {
            context.observed_dirs.insert(target.clone());
        }
    }
}

/// Bounded fingerprint of a directory tree (names, types, sizes, mtimes).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Fingerprint {
    pub entries: BTreeMap<String, String>,
    pub complete: bool,
}

/// Bounded breadth-first fingerprint of the working directory; `.git` is
/// listed but not descended into.
pub fn fingerprint(cwd: &Path, limit: u64) -> Fingerprint {
    let mut entries = BTreeMap::new();
    let mut queue = VecDeque::from([String::new()]);
    while let Some(relative) = queue.pop_front() {
        let dir = if relative.is_empty() {
            cwd.to_path_buf()
        } else {
            cwd.join(&relative)
        };
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<String> = read
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        for name in names {
            if entries.len() as u64 >= limit {
                return Fingerprint {
                    entries,
                    complete: false,
                };
            }
            let child = if relative.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", relative, name)
            };
            let Ok(meta) = fs::symlink_metadata(cwd.join(&child)) else {
                continue;
            };
            let kind = if meta.is_dir() {
                'd'
            } else if meta.file_type().is_symlink() {
                'l'
            } else {
                'f'
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            entries.insert(child.clone(), format!("{}:{}:{}", kind, meta.len(), mtime));
            if kind == 'd' && name != ".git" {
                queue.push_back(child);
            }
        }
    }
    Fingerprint {
        entries,
        complete: true,
    }
}

/// Differences between two fingerprints.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub changed: Vec<String>,
    pub complete: bool,
}

impl Default for EffectDiff {
    fn default() -> Self {
        Self {
            added: Vec::new(),
            removed: Vec::new(),
            changed: Vec::new(),
            complete: true,
        }
    }
}

impl EffectDiff {
    pub fn has_effects(&self) -> bool {
        !(self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty())
    }

    pub fn to_json(&self) -> Value {
        json!({
            "added": self.added,
            "removed": self.removed,
            "changed": self.changed,
            "complete": self.complete,
        })
    }
}

pub fn diff_fingerprints(before: &Fingerprint, after: &Fingerprint) -> EffectDiff {
    let mut diff = EffectDiff {
        complete: before.complete && after.complete,
        ..EffectDiff::default()
    };
    for (name, value) in &after.entries {
        match before.entries.get(name) {
            None => diff.added.push(name.clone()),
            Some(old) if old != value => diff.changed.push(name.clone()),
            _ => {}
        }
    }
    for name in before.entries.keys() {
        if !after.entries.contains_key(name) {
            diff.removed.push(name.clone());
        }
    }
    diff
}

/// Result of reading a change back from the filesystem.
#[derive(Debug, Clone, PartialEq)]
pub struct Verification {
    pub verified: bool,
    pub detail: String,
}

impl Verification {
    pub fn to_json(&self) -> Value {
        json!({ "verified": self.verified, "detail": self.detail })
    }
}

/// Read the result of a successful change back from the filesystem.
pub fn verify_change(tokens: &[String], cwd: &Path) -> Verification {
    let program = tokens.first().map(String::as_str).unwrap_or("");
    let args = operands(tokens);
    let exists = |p: &str| cwd.join(p).exists();
    let is_dir = |p: &str| cwd.join(p).is_dir();
    let mut missing: Vec<String> = Vec::new();
    match program {
        "mkdir" => missing = args.iter().filter(|p| !is_dir(p)).cloned().collect(),
        "touch" => missing = args.iter().filter(|p| !exists(p)).cloned().collect(),
        "rm" | "rmdir" => {
            missing = args
                .iter()
                .filter(|p| exists(p))
                .map(|p| format!("{} (still present)", p))
                .collect()
        }
        "cp" | "mv" if !args.is_empty() => {
            let dest = args[args.len() - 1].clone();
            let sources = &args[..args.len() - 1];
            let expected: Vec<String> = if is_dir(&dest) && !sources.is_empty() {
                sources
                    .iter()
                    .map(|s| {
                        let base = Path::new(s)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        Path::new(&dest).join(base).to_string_lossy().to_string()
                    })
                    .collect()
            } else {
                vec![dest]
            };
            missing = expected.iter().filter(|p| !exists(p)).cloned().collect();
            if program == "mv" {
                missing.extend(
                    sources
                        .iter()
                        .filter(|s| exists(s) && !expected.contains(s))
                        .map(|s| format!("{} (still present)", s)),
                );
            }
        }
        _ => {}
    }
    if missing.is_empty() {
        Verification {
            verified: true,
            detail: format!("readback confirmed {} {}", program, args.join(" ")),
        }
    } else {
        Verification {
            verified: false,
            detail: format!("readback failed: {}", missing.join(", ")),
        }
    }
}

#[cfg(test)]
#[path = "formal_ai_policy_cases.rs"]
pub(crate) mod formal_ai_policy_cases;
