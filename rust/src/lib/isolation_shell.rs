//! Shell command classification and argv rebuilding shared by isolation backends.

use std::process::{Command, Stdio};

use super::{is_debug, IsolationOptions};

const SHELL_NAMES: [&str; 8] = ["bash", "zsh", "sh", "fish", "ksh", "csh", "tcsh", "dash"];

/// Quoting dialect of the shell that will run a rebuilt command line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellQuotingStyle {
    /// `sh`, `bash`, `zsh`: a quote is escaped by closing, escaping and reopening.
    Posix,
    /// PowerShell: a quote inside a literal string is escaped by doubling it.
    PowerShell,
}

impl ShellQuotingStyle {
    /// The dialect of the host shell (`powershell.exe` on Windows, `sh` elsewhere).
    pub fn host() -> Self {
        if cfg!(windows) {
            ShellQuotingStyle::PowerShell
        } else {
            ShellQuotingStyle::Posix
        }
    }
}

/// True when every character is read literally by the target shell, so no quoting is needed.
///
/// The PowerShell set is narrower than the POSIX one: `,` builds an array, `@`
/// splats and `%` is an alias for ForEach-Object.
fn is_safe_arg(arg: &str, style: ShellQuotingStyle) -> bool {
    let extra = match style {
        ShellQuotingStyle::Posix => "_@%+=:,./^-",
        ShellQuotingStyle::PowerShell => "_=:./\\-",
    };
    !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// Quote one argv element so the target shell parses it back as exactly that element (issue #164).
pub fn quote_shell_arg_with(arg: &str, style: ShellQuotingStyle) -> String {
    if is_safe_arg(arg, style) {
        return arg.to_string();
    }
    match style {
        ShellQuotingStyle::Posix => format!("'{}'", arg.replace('\'', "'\\''")),
        ShellQuotingStyle::PowerShell => format!("'{}'", arg.replace('\'', "''")),
    }
}

/// Quote one argv element for the host shell (issue #164).
pub fn quote_shell_arg(arg: &str) -> String {
    quote_shell_arg_with(arg, ShellQuotingStyle::host())
}

/// Rebuild a shell command line from the argv the user typed, for a given shell dialect.
///
/// A single element is a shell script the user quoted as a whole (`$ "ls | wc -l"`)
/// and is kept verbatim; multiple elements were split by the outer shell, so each
/// one is quoted to survive the inner shell unchanged.
pub fn build_command_string_with(argv: &[String], style: ShellQuotingStyle) -> String {
    match argv {
        [] => String::new(),
        [single] => single.clone(),
        _ => argv
            .iter()
            .map(|arg| quote_shell_arg_with(arg, style))
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// Rebuild a shell command line from the argv the user typed, for the host shell (issue #164).
pub fn build_command_string(argv: &[String]) -> String {
    build_command_string_with(argv, ShellQuotingStyle::host())
}

/// Split a command line into shell words, reversing `quote_shell_arg_with` for
/// the same dialect: a POSIX shell escapes with a backslash, PowerShell has no
/// backslash escape (it is a path separator) and writes a literal quote as a
/// doubled one.
///
/// Returns `None` when quoting is unbalanced.
pub fn split_shell_words_with(command: &str, style: ShellQuotingStyle) -> Option<Vec<String>> {
    let is_powershell = style == ShellQuotingStyle::PowerShell;
    let mut words: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(c) = chars.next() {
        if quote.is_none() && c.is_whitespace() {
            if started {
                words.push(std::mem::take(&mut current));
                started = false;
            }
            continue;
        }
        started = true;
        if !is_powershell && c == '\\' && quote != Some('\'') {
            let escaped = chars.next()?;
            current.push(escaped);
            continue;
        }
        if quote.is_none() && (c == '\'' || c == '"') {
            quote = Some(c);
            continue;
        }
        if Some(c) == quote {
            if is_powershell && chars.peek() == Some(&c) {
                chars.next();
                current.push(c);
                continue;
            }
            quote = None;
            continue;
        }
        current.push(c);
    }

    if quote.is_some() {
        return None;
    }
    if started {
        words.push(current);
    }
    Some(words)
}

/// Split a command line into shell words for the host shell dialect.
pub fn split_shell_words(command: &str) -> Option<Vec<String>> {
    split_shell_words_with(command, ShellQuotingStyle::host())
}

/// Split a command into words, falling back to whitespace splitting when quoting is unbalanced.
pub fn to_shell_words(command: &str) -> Vec<String> {
    split_shell_words(command).unwrap_or_else(|| {
        command
            .split_whitespace()
            .map(|part| part.to_string())
            .collect()
    })
}

fn basename(part: &str) -> &str {
    part.rsplit('/').next().unwrap_or(part)
}

fn is_shell_command(parts: &[String]) -> bool {
    parts
        .first()
        .is_some_and(|first| SHELL_NAMES.contains(&basename(first)))
}

/// True if command is a bare shell invocation (no -c); avoids bash-inside-bash (issue #84).
pub fn is_interactive_shell_command(command: &str) -> bool {
    let parts = to_shell_words(command);
    is_shell_command(&parts) && !parts.iter().any(|part| part == "-c")
}

/// True if command is a shell invocation with -c (e.g. `bash -i -c "cmd"`); avoids double-wrapping (issue #91).
pub fn is_shell_invocation_with_args(command: &str) -> bool {
    let parts = to_shell_words(command);
    is_shell_command(&parts) && parts.iter().any(|part| part == "-c")
}

/// Build argv for a shell-with-c command; everything after -c is one script argument.
pub fn build_shell_with_args_cmd_args(command: &str) -> Vec<String> {
    let parts = to_shell_words(command);
    let Some(index) = parts.iter().position(|part| part == "-c") else {
        return parts;
    };
    let script = parts[index + 1..].join(" ");
    let mut result = parts[..=index].to_vec();
    if !script.is_empty() {
        result.push(script);
    }
    result
}

/// Quote an argument for display only, keeping the user-facing double-quoted form (issue #91).
fn quote_for_display(arg: &str) -> String {
    // Display is cosmetic, so it always uses the POSIX set: the rendered command
    // must look the same on every platform.
    if is_safe_arg(arg, ShellQuotingStyle::Posix) {
        arg.to_string()
    } else if arg.contains('"') {
        format!("'{}'", arg)
    } else {
        format!("\"{}\"", arg)
    }
}

/// Build a display string that shows the argument boundaries the user typed (issues #91, #164).
///
/// A command the user quoted as one shell script is shown verbatim, because its
/// metacharacters are meant for the shell, not for display.
pub fn build_display_command(command: &str) -> String {
    if is_shell_invocation_with_args(command) {
        return build_shell_with_args_cmd_args(command)
            .iter()
            .map(|arg| quote_for_display(arg))
            .collect::<Vec<_>>()
            .join(" ");
    }
    match split_shell_words(command) {
        Some(words) if build_command_string(&words) == command => words
            .iter()
            .map(|arg| quote_for_display(arg))
            .collect::<Vec<_>>()
            .join(" "),
        _ => command.to_string(),
    }
}

/// First word of a command line, used for failure reports and log headers.
pub fn command_name(command: &str) -> String {
    to_shell_words(command)
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// Detect the best available shell in an isolation environment (docker/ssh)
/// Tries shells in order: bash, zsh, sh
/// Returns the shell path to use
pub fn detect_shell_in_environment(environment: &str, options: &IsolationOptions) -> String {
    let shell_preference = &options.shell;

    // If a specific shell is requested (not auto), use it directly
    if !shell_preference.is_empty() && shell_preference != "auto" {
        if is_debug() {
            eprintln!("[DEBUG] Using forced shell: {}", shell_preference);
        }
        return shell_preference.clone();
    }

    // In auto mode, try shells in order of preference
    let shells_to_try = ["bash", "zsh", "sh"];

    if environment == "docker" {
        let image = match &options.image {
            Some(i) => i.clone(),
            None => return "sh".to_string(),
        };

        for shell in &shells_to_try {
            let result = Command::new("docker")
                .args([
                    "run",
                    "--rm",
                    &image,
                    "sh",
                    "-c",
                    &format!("command -v {}", shell),
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output();

            if let Ok(output) = result {
                if output.status.success() {
                    let detected = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !detected.is_empty() {
                        if is_debug() {
                            eprintln!(
                                "[DEBUG] Detected shell in docker image {}: {}",
                                image, detected
                            );
                        }
                        return detected;
                    }
                }
            }
        }

        if is_debug() {
            eprintln!(
                "[DEBUG] Could not detect shell in docker image {}, falling back to sh",
                image
            );
        }
        return "sh".to_string();
    }

    if environment == "ssh" {
        let endpoint = match &options.endpoint {
            Some(e) => e.clone(),
            None => return "sh".to_string(),
        };

        // Run a single SSH command to check for available shells in order
        let check_cmd: Vec<String> = shells_to_try
            .iter()
            .map(|s| format!("command -v {}", s))
            .collect();
        let check_cmd_str = check_cmd.join(" || ");

        let result = Command::new("ssh")
            .args([&endpoint, &check_cmd_str])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();

        if let Ok(output) = result {
            if output.status.success() {
                let detected = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !detected.is_empty() {
                    if is_debug() {
                        eprintln!(
                            "[DEBUG] Detected shell on SSH host {}: {}",
                            endpoint, detected
                        );
                    }
                    return detected;
                }
            }
        }

        if is_debug() {
            eprintln!(
                "[DEBUG] Could not detect shell on SSH host {}, falling back to sh",
                endpoint
            );
        }
        return "sh".to_string();
    }

    "sh".to_string()
}
