//! Shell command classification and argv rebuilding shared by isolation backends.

const SHELL_NAMES: [&str; 8] = ["bash", "zsh", "sh", "fish", "ksh", "csh", "tcsh", "dash"];

/// True when every character is read literally by a POSIX shell, so no quoting is needed.
fn is_safe_arg(arg: &str) -> bool {
    !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./^-".contains(c))
}

/// Quote one argv element so a POSIX shell parses it back as exactly that element (issue #164).
pub fn quote_shell_arg(arg: &str) -> String {
    if is_safe_arg(arg) {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

/// Rebuild a shell command line from the argv the user typed (issue #164).
///
/// A single element is a shell script the user quoted as a whole (`$ "ls | wc -l"`)
/// and is kept verbatim; multiple elements were split by the outer shell, so each
/// one is quoted to survive the inner shell unchanged.
pub fn build_command_string(argv: &[String]) -> String {
    match argv {
        [] => String::new(),
        [single] => single.clone(),
        _ => argv
            .iter()
            .map(|arg| quote_shell_arg(arg))
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// Split a command line into shell words, honouring quotes and backslash escapes.
///
/// Returns `None` when quoting is unbalanced.
pub fn split_shell_words(command: &str) -> Option<Vec<String>> {
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
        if c == '\\' && quote != Some('\'') {
            let escaped = chars.next()?;
            current.push(escaped);
            continue;
        }
        if quote.is_none() && (c == '\'' || c == '"') {
            quote = Some(c);
            continue;
        }
        if Some(c) == quote {
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

/// Split a command into words, falling back to whitespace splitting when quoting is unbalanced.
fn to_shell_words(command: &str) -> Vec<String> {
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
    if is_safe_arg(arg) {
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
