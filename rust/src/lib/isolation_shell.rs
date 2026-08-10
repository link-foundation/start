//! Shell command classification shared by isolation backends.

const SHELL_NAMES: [&str; 8] = ["bash", "zsh", "sh", "fish", "ksh", "csh", "tcsh", "dash"];

pub fn is_interactive_shell_command(command: &str) -> bool {
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return false;
    }
    let basename = parts[0].rsplit('/').next().unwrap_or(parts[0]);
    SHELL_NAMES.contains(&basename) && !parts.contains(&"-c")
}

pub fn is_shell_invocation_with_args(command: &str) -> bool {
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return false;
    }
    let basename = parts[0].rsplit('/').next().unwrap_or(parts[0]);
    SHELL_NAMES.contains(&basename) && parts.contains(&"-c")
}

pub fn build_shell_with_args_cmd_args(command: &str) -> Vec<String> {
    let parts: Vec<&str> = command.split_whitespace().collect();
    let Some(index) = parts.iter().position(|&part| part == "-c") else {
        return parts.iter().map(|part| (*part).to_string()).collect();
    };
    let script = parts[index + 1..].join(" ");
    let mut result = parts[..=index]
        .iter()
        .map(|part| (*part).to_string())
        .collect::<Vec<_>>();
    if !script.is_empty() {
        result.push(script);
    }
    result
}
