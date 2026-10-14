//! Bounded byte-wise sanitization for logs prepared for publication.

use regex::bytes::Regex;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const BLOCK_SIZE: usize = 64 * 1024;
const MARKER: &[u8] = b"[REDACTED]";
const BLOCKED: &str = "Log sanitization failed; upload blocked.";

#[derive(Clone, Copy)]
enum Continuation {
    Token,
    Jwt,
    Line,
    Value,
    Url,
    AnyValue,
}

impl Continuation {
    fn accepts(self, byte: u8) -> bool {
        match self {
            Self::Token => byte.is_ascii_alphanumeric() || b"_-".contains(&byte),
            Self::Jwt => byte.is_ascii_alphanumeric() || b"_.-".contains(&byte),
            Self::Line => !b"\r\n".contains(&byte),
            Self::Value => !byte.is_ascii_whitespace() && !b"\"';,".contains(&byte),
            Self::Url => !byte.is_ascii_whitespace() && byte != b'@',
            Self::AnyValue => !byte.is_ascii_whitespace(),
        }
    }

    fn union(self, other: Self) -> Self {
        // Nested tokens must not narrow a containing header/URL's suffix.
        match (self, other) {
            (Self::Line, _) | (_, Self::Line) => Self::Line,
            (Self::AnyValue, _) | (_, Self::AnyValue) => Self::AnyValue,
            (Self::Value, Self::Url) | (Self::Url, Self::Value) => Self::AnyValue,
            (Self::Value, _) | (_, Self::Value) => Self::Value,
            (Self::Url, _) | (_, Self::Url) => Self::Url,
            (Self::Jwt, _) | (_, Self::Jwt) => Self::Jwt,
            _ => Self::Token,
        }
    }
}

fn rules() -> &'static [(Regex, Option<Continuation>)] {
    static RULES: OnceLock<Vec<(Regex, Option<Continuation>)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            (
                r"\b[A-Za-z0-9_-]{2,512}\.[A-Za-z0-9_-]{2,512}\.[A-Za-z0-9_-]{0,512}",
                Some(Continuation::Jwt),
            ),
            (
                r"[A-Za-z0-9_-]{512,}[A-Za-z0-9_.-]*",
                Some(Continuation::Jwt),
            ),
            (
                r"(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]*",
                Some(Continuation::Token),
            ),
            (r"(?:AKIA|ASIA)[A-Z0-9]{16}", None),
            (r"eyJ[A-Za-z0-9_.-]*", Some(Continuation::Jwt)),
            (
                r"(?i:(?:Proxy-)?Authorization)[ \t]{0,32}:[^\r\n]*",
                Some(Continuation::Line),
            ),
            (
                r#"(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)[ \t]{0,32}[=:][ \t]*["']?[^\s"';,]*"#,
                Some(Continuation::Value),
            ),
            (
                r"(?:https?|git|ssh)://[^\s:/@]{1,256}:[^\s@]*",
                Some(Continuation::Url),
            ),
        ]
        .into_iter()
        .map(|(pattern, continuation)| {
            (
                regex::bytes::RegexBuilder::new(pattern)
                    .unicode(false)
                    .build()
                    .expect("static credential rule"),
                continuation,
            )
        })
        .collect()
    })
}

fn is_jwt(value: &[u8]) -> bool {
    use base64::Engine;
    let header = value.split(|byte| *byte == b'.').next().unwrap_or_default();
    let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(header) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|header| {
            header
                .get("alg")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .is_some()
}

/// Holds at most one block of pending bytes, independent of source file size.
/// Very long credential-like words are conservatively redacted as well.
pub struct StreamingSanitizer {
    secrets: Vec<Vec<u8>>,
    holdback: usize,
    pending: Vec<u8>,
    continuation: Option<Continuation>,
    pub redactions: u64,
}

impl StreamingSanitizer {
    pub fn new(env: impl IntoIterator<Item = (String, String)>) -> Result<Self, String> {
        Self::new_bytes(
            env.into_iter()
                .map(|(name, value)| (name, value.into_bytes())),
        )
    }

    fn new_bytes(env: impl IntoIterator<Item = (String, Vec<u8>)>) -> Result<Self, String> {
        let env_name = Regex::new(r"(?i)(?:^|_)(?:TOKEN|(?:API|ACCESS|PRIVATE)?KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PAT)(?:_|$)")
            .map_err(|_| BLOCKED.to_string())?;
        let mut secrets: Vec<Vec<u8>> = env
            .into_iter()
            .filter(|(name, value)| env_name.is_match(name.as_bytes()) && !value.is_empty())
            .map(|(_, value)| value)
            .collect();
        if secrets.iter().any(|value| value.len() > BLOCK_SIZE) {
            return Err(
                "Known environment secret is too large for bounded sanitization.".to_string(),
            );
        }
        secrets.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
        secrets.dedup();
        let holdback = secrets.iter().map(Vec::len).max().unwrap_or(0).max(2048);
        Ok(Self {
            secrets,
            holdback,
            pending: Vec::new(),
            continuation: None,
            redactions: 0,
        })
    }

    pub fn pending_bytes(&self) -> usize {
        self.pending.len()
    }

    fn find_matches(&self, input: &[u8]) -> Vec<(usize, usize, Option<Continuation>)> {
        let mut matches = Vec::new();
        for (index, (rule, continuation)) in rules().iter().enumerate() {
            for found in rule.find_iter(input) {
                if index != 0 || is_jwt(&input[found.start()..found.end()]) {
                    matches.push((found.start(), found.end(), *continuation));
                }
            }
        }
        for secret in &self.secrets {
            for (index, _) in input
                .windows(secret.len())
                .enumerate()
                .filter(|(_, window)| *window == secret)
            {
                matches.push((index, index + secret.len(), None));
            }
        }
        matches.sort_unstable_by_key(|(index, end, _)| (*index, std::cmp::Reverse(*end)));
        let mut merged: Vec<(usize, usize, Option<Continuation>)> = Vec::new();
        for (index, end, continuation) in matches {
            if let Some(previous) = merged.last_mut().filter(|previous| index <= previous.1) {
                if end > previous.1 {
                    previous.1 = end;
                    previous.2 = continuation;
                } else if end == previous.1 && continuation.is_some() {
                    previous.2 = match (previous.2, continuation) {
                        (Some(retained), Some(additional)) => Some(retained.union(additional)),
                        _ => continuation,
                    };
                }
            } else {
                merged.push((index, end, continuation));
            }
        }
        merged
    }

    pub fn push(&mut self, block: &[u8], final_block: bool) -> Vec<u8> {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(block);
        let mut beginning = 0;
        if let Some(continuation) = self.continuation {
            beginning = input
                .iter()
                .take_while(|byte| continuation.accepts(**byte))
                .count();
            if beginning == input.len() && !final_block {
                return Vec::new();
            }
            self.continuation = None;
        }
        let input = &input[beginning..];
        let safe_end = if final_block {
            input.len()
        } else {
            input.len().saturating_sub(self.holdback)
        };
        let mut offset = 0;
        let mut output = Vec::new();
        for (start, end, continuation) in self.find_matches(input) {
            if start >= safe_end {
                break;
            }
            output.extend_from_slice(&input[offset..start]);
            output.extend_from_slice(MARKER);
            self.redactions += 1;
            offset = end;
            if offset == input.len() && continuation.is_some() && !final_block {
                self.continuation = continuation;
                break;
            }
        }
        let end = offset.max(safe_end);
        output.extend_from_slice(&input[offset..end]);
        self.pending.extend_from_slice(&input[end..]);
        output
    }
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

pub fn sanitize_log_to_temp(source_path: &Path, verbose: bool) -> Result<PreparedLog, String> {
    let values = std::env::vars_os().map(|(name, value)| {
        #[cfg(unix)]
        let bytes = {
            use std::os::unix::ffi::OsStringExt;
            value.into_vec()
        };
        #[cfg(not(unix))]
        let bytes = value.to_string_lossy().into_owned().into_bytes();
        (name.to_string_lossy().into_owned(), bytes)
    });
    sanitize_log_to_temp_with_bytes(source_path, values, verbose)
}

pub fn sanitize_log_to_temp_with_env(
    source_path: &Path,
    env: impl IntoIterator<Item = (String, String)>,
    verbose: bool,
) -> Result<PreparedLog, String> {
    sanitize_log_to_temp_with_bytes(
        source_path,
        env.into_iter()
            .map(|(name, value)| (name, value.into_bytes())),
        verbose,
    )
}

fn sanitize_log_to_temp_with_bytes(
    source_path: &Path,
    env: impl IntoIterator<Item = (String, Vec<u8>)>,
    verbose: bool,
) -> Result<PreparedLog, String> {
    let blocked_at = |stage| {
        if verbose {
            eprintln!("Log sanitization failed at stage: {}.", stage);
        }
        BLOCKED.to_string()
    };
    // Static errors prevent paths and system error details from leaking secrets.
    let mut sanitizer =
        StreamingSanitizer::new_bytes(env).map_err(|_| blocked_at("environment"))?;
    let mut source = File::open(source_path).map_err(|_| blocked_at("source"))?;
    if !source
        .metadata()
        .map_err(|_| blocked_at("source"))?
        .is_file()
    {
        return Err(blocked_at("source"));
    }
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
        .map_err(|_| blocked_at("private-file"))?;
    let prepared = PreparedLog {
        path: directory.join("execution.log"),
        directory,
    };
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut destination = options
        .open(&prepared.path)
        .map_err(|_| blocked_at("private-file"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        destination
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| blocked_at("private-file"))?;
    }
    let mut buffer = [0; BLOCK_SIZE];
    let mut bytes = 0_u64;
    loop {
        let length = source.read(&mut buffer).map_err(|_| blocked_at("read"))?;
        if length == 0 {
            break;
        }
        bytes += length as u64;
        destination
            .write_all(&sanitizer.push(&buffer[..length], false))
            .map_err(|_| blocked_at("write"))?;
    }
    destination
        .write_all(&sanitizer.push(&[], true))
        .map_err(|_| blocked_at("write"))?;
    destination.sync_all().map_err(|_| blocked_at("sync"))?;
    drop(destination);
    if verbose {
        println!(
            "Prepared private sanitized log: {} bytes scanned, {} redactions.",
            bytes, sanitizer.redactions
        );
    }
    Ok(prepared)
}
