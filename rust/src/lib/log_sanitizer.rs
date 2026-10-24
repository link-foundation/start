//! Prepares logs and issue text for publication with
//! @link-foundation/sensitive-data-sanitizer, the sanitizer shared by
//! start-command, gh-upload-log and hive-mind (issue #250).
//!
//! The library CLI runs with `--credentials-only`, `--env-secrets` and
//! `--gh-config`; it streams the log from stdin, keeps invalid UTF-8 bytes and
//! writes a new private file atomically (`--output`). Its error messages are
//! value-free and only their `ERR_*` code is kept here.
//!
//! Since 0.12.1 the library masks only the scheme and token of an
//! `Authorization: <scheme> <value>` header, so a logged one-line JSON prompt
//! keeps the rest of its line (issue #249, sensitive-data-sanitizer#45); the
//! pre-pass that did this here is gone (issue #253).

use regex::bytes::Regex;
use std::ffi::OsString;
use std::fs::{self, DirBuilder, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

pub const BLOCK_SIZE: usize = 64 * 1024;
const MARKER: &[u8] = b"[REDACTED]";
const COMMAND: &str = "sensitive-data-sanitizer";
/// The library version the JavaScript package depends on.
pub const PACKAGE: &str = "@link-foundation/sensitive-data-sanitizer@^0.12.1";
/// Path of the library CLI to use instead of the one on PATH.
pub const OVERRIDE: &str = "START_SENSITIVE_DATA_SANITIZER";
const OPTIONS: [&str; 3] = ["--credentials-only", "--env-secrets", "--gh-config"];

/// Value-free failure message: `code` is a fixed ERR_* name, never content.
fn blocked(code: &str, subject: &str) -> String {
    let action = if subject == "Log" {
        "upload"
    } else {
        "publication"
    };
    format!(
        "{} sanitization failed ({}); {} blocked.",
        subject, code, action
    )
}

/// The environment the library runs with: inherited, or exactly the given
/// variables (so tests control which credential-named values it masks).
enum Environment {
    Inherit,
    Explicit(Vec<(String, String)>),
}

impl Environment {
    fn get(&self, name: &str) -> Option<OsString> {
        match self {
            Self::Inherit => std::env::var_os(name),
            Self::Explicit(values) => values
                .iter()
                .find(|(key, _)| {
                    if cfg!(windows) {
                        key.eq_ignore_ascii_case(name)
                    } else {
                        key == name
                    }
                })
                .map(|(_, value)| value.into()),
        }
    }

    fn apply(&self, command: &mut Command) {
        if let Self::Explicit(values) = self {
            command.env_clear().envs(values.iter().cloned());
        }
    }
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    metadata.is_file()
}

fn resolve(env: &Environment) -> Option<PathBuf> {
    if let Some(command) = env.get(OVERRIDE).filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(command));
    }
    // npm installs a .cmd shim on Windows next to a POSIX script of the bare
    // name; Rust runs .exe/.cmd/.bat files, with argument escaping for batch.
    let names: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    let path = env.get("PATH")?;
    std::env::split_paths(&path).find_map(|directory| {
        names
            .iter()
            .map(|extension| directory.join(format!("{}{}", COMMAND, extension)))
            .find(|candidate| is_executable(candidate))
    })
}

/// The library CLI: START_SENSITIVE_DATA_SANITIZER, else sensitive-data-sanitizer on PATH.
pub fn find_sanitizer() -> Option<PathBuf> {
    resolve(&Environment::Inherit)
}

/// Install the library CLI with an available JavaScript package manager.
pub fn ensure_sanitizer_available() -> Result<(), String> {
    if find_sanitizer().is_some() {
        return Ok(());
    }
    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    for command in ["bun", npm] {
        let available = Command::new(command)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !available {
            continue;
        }
        let args = ["install", "-g", PACKAGE];
        println!(
            "{} not found; installing with: {} {}",
            COMMAND,
            command,
            args.join(" ")
        );
        let installed = Command::new(command)
            .args(args)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if installed && find_sanitizer().is_some() {
            return Ok(());
        }
    }
    Err(format!(
        "{} is not installed and automatic installation did not make it available on PATH.",
        COMMAND
    ))
}

fn error_code(stderr: &[u8]) -> String {
    static CODE: OnceLock<Regex> = OnceLock::new();
    CODE.get_or_init(|| Regex::new(r"\bERR_[A-Z_]+\b").expect("static code rule"))
        .find(stderr)
        .map(|code| String::from_utf8_lossy(code.as_bytes()).into_owned())
        .unwrap_or_else(|| "ERR_SANITIZER".to_string())
}

fn sanitizer_command(env: &Environment, subject: &str) -> Result<Command, String> {
    let program = resolve(env).ok_or_else(|| blocked("ERR_UNAVAILABLE", subject))?;
    let mut command = Command::new(program);
    env.apply(&mut command);
    command.arg("redact").arg("-");
    Ok(command)
}

fn text_with(text: &str, env: &Environment) -> Result<String, String> {
    let fail = |code: &str| blocked(code, "Text");
    let input = text.as_bytes().to_vec();
    let mut child = sanitizer_command(env, "Text")?
        .args(OPTIONS)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| fail("ERR_UNAVAILABLE"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| fail("ERR_SANITIZER"))?;
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child
        .wait_with_output()
        .map_err(|_| fail("ERR_SANITIZER"))?;
    let written = writer.join().map(|result| result.is_ok()).unwrap_or(false);
    if !output.status.success() {
        return Err(fail(&error_code(&output.stderr)));
    }
    if !written {
        return Err(fail("ERR_SANITIZER"));
    }
    String::from_utf8(output.stdout).map_err(|_| fail("ERR_SANITIZER"))
}

/// Sanitize a short text, such as the failing command quoted in an issue.
pub fn sanitize_text(text: &str) -> Result<String, String> {
    text_with(text, &Environment::Inherit)
}

pub fn sanitize_text_with_env(
    text: &str,
    env: impl IntoIterator<Item = (String, String)>,
) -> Result<String, String> {
    text_with(text, &Environment::Explicit(env.into_iter().collect()))
}

/// Private temporary copy; dropping it removes its file and directory.
pub struct PreparedLog {
    pub path: PathBuf,
    directory: PathBuf,
}

impl Drop for PreparedLog {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn count_markers(path: &Path) -> std::io::Result<u64> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0; BLOCK_SIZE];
    let mut text = Vec::new();
    let mut count = 0;
    loop {
        let length = file.read(&mut buffer)?;
        text.extend_from_slice(&buffer[..length]);
        let mut next = 0;
        while let Some(index) = text[next..]
            .windows(MARKER.len())
            .position(|window| window == MARKER)
        {
            count += 1;
            next += index + MARKER.len();
        }
        if length == 0 {
            return Ok(count);
        }
        let keep = next.max(text.len().saturating_sub(MARKER.len() - 1));
        text.drain(..keep);
    }
}

fn private_directory() -> Result<PathBuf, String> {
    let directory = std::env::temp_dir().join(format!("start-sanitized-{}", uuid::Uuid::new_v4()));
    let builder = DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder
        .create(&directory)
        .map_err(|_| blocked("ERR_PRIVATE_FILE", "Log"))?;
    Ok(directory)
}

fn log_with(source_path: &Path, env: &Environment, verbose: bool) -> Result<PreparedLog, String> {
    // Static messages keep paths and system error details out of the output.
    let directory = private_directory()?;
    let prepared = PreparedLog {
        path: directory.join("execution.log"),
        directory,
    };
    let target = prepared.path.clone();
    let source_error = |_| blocked("ERR_SOURCE", "Log");
    let source = File::open(source_path).map_err(source_error)?;
    let metadata = source.metadata().map_err(source_error)?;
    if !metadata.is_file() {
        return Err(blocked("ERR_SOURCE", "Log"));
    }
    let bytes = metadata.len();
    let output = sanitizer_command(env, "Log")?
        .arg("--stream")
        .args(OPTIONS)
        .arg("--max-bytes")
        .arg(bytes.max(1).to_string())
        .arg("--output")
        .arg(&target)
        .stdin(Stdio::from(source))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|_| blocked("ERR_UNAVAILABLE", "Log"))?;
    if !output.status.success() {
        return Err(blocked(&error_code(&output.stderr), "Log"));
    }
    let metadata = fs::symlink_metadata(&target).map_err(|_| blocked("ERR_OUTPUT", "Log"))?;
    #[cfg(unix)]
    let private = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o077 == 0
    };
    #[cfg(not(unix))]
    let private = true;
    if !metadata.is_file() || !private {
        return Err(blocked("ERR_OUTPUT", "Log"));
    }
    if verbose {
        let redactions = count_markers(&target)
            .unwrap_or(0)
            .saturating_sub(count_markers(source_path).unwrap_or(0));
        println!(
            "Prepared private sanitized log: {} bytes scanned, {} redactions.",
            bytes, redactions
        );
    }
    Ok(prepared)
}

fn report(result: Result<PreparedLog, String>, verbose: bool) -> Result<PreparedLog, String> {
    if let (Err(message), true) = (&result, verbose) {
        eprintln!("{}", message);
    }
    result
}

/// Create a private sanitized copy of a log. The source is never modified;
/// any failure removes the copy and returns a value-free message.
pub fn sanitize_log_to_temp(source_path: &Path, verbose: bool) -> Result<PreparedLog, String> {
    report(
        log_with(source_path, &Environment::Inherit, verbose),
        verbose,
    )
}

pub fn sanitize_log_to_temp_with_env(
    source_path: &Path,
    env: impl IntoIterator<Item = (String, String)>,
    verbose: bool,
) -> Result<PreparedLog, String> {
    let env = Environment::Explicit(env.into_iter().collect());
    report(log_with(source_path, &env, verbose), verbose)
}
