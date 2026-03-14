//! Isolation Runners for start-command
//!
//! Provides execution of commands in various isolated environments:
//! - screen: GNU Screen terminal multiplexer
//! - tmux: tmux terminal multiplexer
//! - docker: Docker containers
//! - ssh: Remote SSH execution

use std::env;
use std::process::{Command, Stdio};

use crate::args_parser::generate_session_name;

/// Result of an isolation run
#[derive(Debug, Default)]
pub struct IsolationResult {
    /// Whether the run succeeded
    pub success: bool,
    /// Session or container name
    pub session_name: Option<String>,
    /// Container ID (for docker)
    pub container_id: Option<String>,
    /// Message describing the result
    pub message: String,
    /// Exit code
    pub exit_code: Option<i32>,
    /// Captured output
    pub output: Option<String>,
}

/// Options for isolation
#[derive(Debug, Clone)]
pub struct IsolationOptions {
    /// Session name
    pub session: Option<String>,
    /// Docker image
    pub image: Option<String>,
    /// SSH endpoint
    pub endpoint: Option<String>,
    /// Run in detached mode
    pub detached: bool,
    /// User to run command as
    pub user: Option<String>,
    /// Keep environment alive after command exits
    pub keep_alive: bool,
    /// Auto-remove docker container after exit
    pub auto_remove_docker_container: bool,
    /// Shell to use in isolation environments: auto, bash, zsh, sh
    pub shell: String,
}

impl Default for IsolationOptions {
    fn default() -> Self {
        IsolationOptions {
            session: None,
            image: None,
            endpoint: None,
            detached: false,
            user: None,
            keep_alive: false,
            auto_remove_docker_container: false,
            shell: "auto".to_string(),
        }
    }
}

/// Check if a command is available on the system
pub fn is_command_available(command: &str) -> bool {
    let check_cmd = if cfg!(windows) { "where" } else { "which" };
    Command::new(check_cmd)
        .arg(command)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Get the shell to use for command execution
pub fn get_shell() -> (String, String) {
    if cfg!(windows) {
        ("cmd.exe".to_string(), "/c".to_string())
    } else {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        (shell, "-c".to_string())
    }
}

/// Check if the current process has a TTY attached
pub fn has_tty() -> bool {
    atty::is(atty::Stream::Stdin) && atty::is(atty::Stream::Stdout)
}

/// Wrap command with sudo -u if user option is specified
pub fn wrap_command_with_user(command: &str, user: Option<&str>) -> String {
    match user {
        Some(u) => {
            // Escape single quotes in command
            let escaped = command.replace('\'', "'\\''");
            format!("sudo -n -u {} sh -c '{}'", u, escaped)
        }
        None => command.to_string(),
    }
}

/// Shell names recognized as bare interactive shells (without -c flag).
/// Mirrors JS SHELL_NAMES constant in isolation.js.
const SHELL_NAMES: [&str; 8] = ["bash", "zsh", "sh", "fish", "ksh", "csh", "tcsh", "dash"];

/// Returns true if command is a bare interactive shell invocation (no -c flag).
/// Used to avoid double-wrapping shells in isolation environments (issue #84).
///
/// Examples: "bash", "zsh", "bash --norc", "/usr/local/bin/bash"
/// Counter-examples: "bash -c echo hi", "npm test"
pub fn is_interactive_shell_command(command: &str) -> bool {
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return false;
    }
    let basename = parts[0].rsplit('/').next().unwrap_or(parts[0]);
    SHELL_NAMES.contains(&basename) && !parts.contains(&"-c")
}

/// Returns true if command is a shell invocation that includes -c (e.g. `bash -i -c "cmd"`).
/// Used to pass such commands directly without double-wrapping (issue #91).
pub fn is_shell_invocation_with_args(command: &str) -> bool {
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return false;
    }
    let basename = parts[0].rsplit('/').next().unwrap_or(parts[0]);
    SHELL_NAMES.contains(&basename) && parts.contains(&"-c")
}

/// Build argv for a shell-with-c command; everything after -c is joined as one argument.
/// Reverses the join(' ') that collapsed the original quoted argument.
/// Used to pass `bash -i -c "nvm --version"` directly as argv (issue #91 fix).
pub fn build_shell_with_args_cmd_args(command: &str) -> Vec<String> {
    let parts: Vec<&str> = command.split_whitespace().collect();
    let c_idx = parts.iter().position(|&p| p == "-c");
    match c_idx {
        None => parts.iter().map(|s| s.to_string()).collect(),
        Some(idx) => {
            let script_arg = parts[idx + 1..].join(" ");
            let mut result: Vec<String> = parts[..idx + 1].iter().map(|s| s.to_string()).collect();
            if !script_arg.is_empty() {
                result.push(script_arg);
            }
            result
        }
    }
}

/// Returns "-i" for bash/zsh (interactive mode, sources startup files), None for other shells.
fn get_shell_interactive_flag(shell_path: &str) -> Option<&'static str> {
    let shell_name = shell_path.rsplit('/').next().unwrap_or(shell_path);
    match shell_name {
        "bash" => Some("-i"),
        "zsh" => Some("-i"),
        _ => None,
    }
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

#[path = "isolation_screen.rs"]
pub mod isolation_screen;
pub use self::isolation_screen::{get_screen_version, supports_logfile_option};

/// Run command in GNU Screen
pub fn run_in_screen(command: &str, options: &IsolationOptions) -> IsolationResult {
    if !is_command_available("screen") {
        return IsolationResult {
            success: false,
            message: "screen is not installed. Install it with: sudo apt-get install screen (Debian/Ubuntu) or brew install screen (macOS)".to_string(),
            ..Default::default()
        };
    }

    let session_name = options
        .session
        .clone()
        .unwrap_or_else(|| generate_session_name(Some("screen")));

    let (shell, shell_arg) = get_shell();
    let effective_command = wrap_command_with_user(command, options.user.as_deref());

    if options.detached {
        // Detached mode
        let final_command = if options.keep_alive {
            format!("{}; exec {}", effective_command, shell)
        } else {
            effective_command.clone()
        };

        let status = Command::new("screen")
            .args(["-dmS", &session_name, &shell, &shell_arg, &final_command])
            .status();

        match status {
            Ok(s) if s.success() => {
                let mut message = format!(
                    "Command started in detached screen session: {}",
                    session_name
                );
                if options.keep_alive {
                    message.push_str("\nSession will stay alive after command completes.");
                } else {
                    message.push_str("\nSession will exit automatically after command completes.");
                }
                message.push_str(&format!("\nReattach with: screen -r {}", session_name));

                IsolationResult {
                    success: true,
                    session_name: Some(session_name),
                    message,
                    ..Default::default()
                }
            }
            _ => IsolationResult {
                success: false,
                session_name: Some(session_name),
                message: "Failed to start screen session".to_string(),
                ..Default::default()
            },
        }
    } else {
        // Attached mode with log capture
        isolation_screen::run_screen_with_log_capture(
            command,
            &session_name,
            options.user.as_deref(),
        )
    }
}

/// Run command in tmux
pub fn run_in_tmux(command: &str, options: &IsolationOptions) -> IsolationResult {
    if !is_command_available("tmux") {
        return IsolationResult {
            success: false,
            message: "tmux is not installed. Install it with: sudo apt-get install tmux (Debian/Ubuntu) or brew install tmux (macOS)".to_string(),
            ..Default::default()
        };
    }

    let session_name = options
        .session
        .clone()
        .unwrap_or_else(|| generate_session_name(Some("tmux")));

    let (shell, _) = get_shell();
    let effective_command = wrap_command_with_user(command, options.user.as_deref());

    if options.detached {
        let final_command = if options.keep_alive {
            format!("{}; exec {}", effective_command, shell)
        } else {
            effective_command.clone()
        };

        let status = Command::new("tmux")
            .args(["new-session", "-d", "-s", &session_name, &final_command])
            .status();

        match status {
            Ok(s) if s.success() => {
                let mut message =
                    format!("Command started in detached tmux session: {}", session_name);
                if options.keep_alive {
                    message.push_str("\nSession will stay alive after command completes.");
                } else {
                    message.push_str("\nSession will exit automatically after command completes.");
                }
                message.push_str(&format!("\nReattach with: tmux attach -t {}", session_name));

                IsolationResult {
                    success: true,
                    session_name: Some(session_name),
                    message,
                    ..Default::default()
                }
            }
            _ => IsolationResult {
                success: false,
                session_name: Some(session_name),
                message: "Failed to start tmux session".to_string(),
                ..Default::default()
            },
        }
    } else {
        // Attached mode
        let output = Command::new("tmux")
            .args(["new-session", "-s", &session_name, &effective_command])
            .status();

        match output {
            Ok(status) => IsolationResult {
                success: status.success(),
                session_name: Some(session_name.clone()),
                message: format!(
                    "Tmux session \"{}\" exited with code {}",
                    session_name,
                    status.code().unwrap_or(-1)
                ),
                exit_code: status.code(),
                ..Default::default()
            },
            Err(e) => IsolationResult {
                success: false,
                session_name: Some(session_name),
                message: format!("Failed to start tmux: {}", e),
                ..Default::default()
            },
        }
    }
}

/// Run command over SSH
pub fn run_in_ssh(command: &str, options: &IsolationOptions) -> IsolationResult {
    if !is_command_available("ssh") {
        return IsolationResult {
            success: false,
            message: "ssh is not installed".to_string(),
            ..Default::default()
        };
    }

    let endpoint = match &options.endpoint {
        Some(e) => e.clone(),
        None => {
            return IsolationResult {
                success: false,
                message: "SSH isolation requires --endpoint option".to_string(),
                ..Default::default()
            };
        }
    };

    let session_name = options
        .session
        .clone()
        .unwrap_or_else(|| generate_session_name(Some("ssh")));

    // Detect the shell to use on the remote host
    let shell_to_use = detect_shell_in_environment("ssh", options);
    // Use interactive mode (-i) for shells that support it (bash, zsh) so that startup
    // files like .bashrc are sourced, making tools like nvm available in commands.
    let shell_interactive_flag = get_shell_interactive_flag(&shell_to_use);

    if options.detached {
        // Detached mode: run in background on remote server using nohup
        // Build the shell invocation with interactive flag if supported
        let shell_invocation = if let Some(flag) = shell_interactive_flag {
            format!("{} {}", shell_to_use, flag)
        } else {
            shell_to_use.clone()
        };
        let remote_command = format!(
            "nohup {} -c {} > /tmp/{}.log 2>&1 &",
            shell_invocation,
            shell_escape(command),
            session_name
        );
        let ssh_args = vec![endpoint.as_str(), remote_command.as_str()];

        if is_debug() {
            eprintln!("[DEBUG] Running: ssh {:?}", ssh_args);
            eprintln!("[DEBUG] shell: {}", shell_invocation);
        }

        let status = Command::new("ssh").args(&ssh_args).status();

        match status {
            Ok(s) if s.success() => IsolationResult {
                success: true,
                session_name: Some(session_name.clone()),
                message: format!(
                    "Command started in detached SSH session on {}\nSession: {}\nView logs: ssh {} \"tail -f /tmp/{}.log\"",
                    endpoint, session_name, endpoint, session_name
                ),
                ..Default::default()
            },
            _ => IsolationResult {
                success: false,
                session_name: Some(session_name),
                message: "Failed to start SSH session".to_string(),
                ..Default::default()
            },
        }
    } else {
        // Attached mode: Run command using the detected shell with interactive mode
        // so that startup files (.bashrc etc.) are sourced and tools like nvm are available.
        let mut ssh_cmd_args = vec![endpoint.clone(), shell_to_use.clone()];
        if let Some(flag) = shell_interactive_flag {
            ssh_cmd_args.push(flag.to_string());
        }
        ssh_cmd_args.push("-c".to_string());
        ssh_cmd_args.push(command.to_string());

        if is_debug() {
            eprintln!("[DEBUG] Running: ssh {:?}", ssh_cmd_args);
            eprintln!("[DEBUG] shell: {}", shell_to_use);
        }

        let status = Command::new("ssh").args(&ssh_cmd_args).status();

        match status {
            Ok(s) => IsolationResult {
                success: s.success(),
                session_name: Some(session_name.clone()),
                message: format!(
                    "SSH session \"{}\" on {} exited with code {}",
                    session_name,
                    endpoint,
                    s.code().unwrap_or(-1)
                ),
                exit_code: s.code(),
                ..Default::default()
            },
            Err(e) => IsolationResult {
                success: false,
                session_name: Some(session_name),
                message: format!("Failed to start SSH: {}", e),
                ..Default::default()
            },
        }
    }
}

/// Check if a Docker image exists locally
pub fn docker_image_exists(image: &str) -> bool {
    Command::new("docker")
        .args(["image", "inspect", image])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Pull a Docker image with output streaming
/// Returns (success, output) tuple
pub fn docker_pull_image(image: &str) -> (bool, String) {
    use std::io::{BufRead, BufReader};

    // Print the virtual command line followed by empty line for visual separation
    println!(
        "{}",
        crate::output_blocks::create_virtual_command_block(&format!("docker pull {}", image))
    );
    println!();

    let mut child = match Command::new("docker")
        .args(["pull", image])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let error_msg = format!("Failed to run docker pull: {}", e);
            eprintln!("{}", error_msg);
            println!();
            println!(
                "{}",
                crate::output_blocks::create_virtual_command_result(false)
            );
            return (false, error_msg);
        }
    };

    let mut output = String::new();

    // Read and display stdout
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            println!("{}", line);
            output.push_str(&line);
            output.push('\n');
        }
    }

    // Read and display stderr
    if let Some(stderr) = child.stderr.take() {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("{}", line);
            output.push_str(&line);
            output.push('\n');
        }
    }

    let success = child.wait().map(|s| s.success()).unwrap_or(false);

    // Print empty line before result marker for visual separation (issue #73)
    // This ensures output is visually separated from the result marker
    println!();
    println!(
        "{}",
        crate::output_blocks::create_virtual_command_result(success)
    );
    println!("{}", crate::output_blocks::create_timeline_separator());

    (success, output)
}

/// Run command in Docker container
pub fn run_in_docker(command: &str, options: &IsolationOptions) -> IsolationResult {
    if !is_command_available("docker") {
        return IsolationResult {
            success: false,
            message:
                "docker is not installed. Install Docker from https://docs.docker.com/get-docker/"
                    .to_string(),
            ..Default::default()
        };
    }

    let image = match &options.image {
        Some(i) => i.clone(),
        None => {
            return IsolationResult {
                success: false,
                message: "Docker isolation requires --image option".to_string(),
                ..Default::default()
            };
        }
    };

    // Check if image exists locally; if not, pull it as a virtual command
    if !docker_image_exists(&image) {
        let (pull_success, _pull_output) = docker_pull_image(&image);
        if !pull_success {
            return IsolationResult {
                success: false,
                message: format!("Failed to pull Docker image: {}", image),
                exit_code: Some(1),
                ..Default::default()
            };
        }
    }

    let container_name = options
        .session
        .clone()
        .unwrap_or_else(|| generate_session_name(Some("docker")));

    // Detect the shell to use in the container
    let shell_to_use = detect_shell_in_environment("docker", options);
    // Use interactive mode (-i) for shells that support it (bash, zsh) so that startup
    // files like .bashrc are sourced, making tools like nvm available in commands.
    let shell_interactive_flag = get_shell_interactive_flag(&shell_to_use);

    // Print the user command (this appears after any virtual commands like docker pull)
    println!("{}", crate::output_blocks::create_command_line(command));
    println!();

    if options.detached {
        let effective_command = if options.keep_alive {
            format!("{}; exec {}", command, shell_to_use)
        } else {
            command.to_string()
        };

        let mut args = vec!["run", "-d", "--name", &container_name];

        if options.auto_remove_docker_container {
            args.push("--rm");
        }

        if let Some(ref user) = options.user {
            args.push("--user");
            args.push(user);
        }

        args.push(&image);
        args.push(&shell_to_use);
        if let Some(flag) = shell_interactive_flag {
            args.push(flag);
        }
        args.extend(&["-c", &effective_command]);

        if is_debug() {
            eprintln!("[DEBUG] Running: docker {:?}", args);
            eprintln!("[DEBUG] shell: {}", shell_to_use);
        }

        match Command::new("docker").args(&args).output() {
            Ok(output) if output.status.success() => {
                let container_id = String::from_utf8_lossy(&output.stdout).trim().to_string();

                let mut message = format!(
                    "Command started in detached docker container: {}",
                    container_name
                );
                message.push_str(&format!(
                    "\nContainer ID: {}",
                    &container_id[..12.min(container_id.len())]
                ));
                if options.keep_alive {
                    message.push_str("\nContainer will stay alive after command completes.");
                } else {
                    message
                        .push_str("\nContainer will exit automatically after command completes.");
                }
                if options.auto_remove_docker_container {
                    message.push_str("\nContainer will be automatically removed after exit.");
                } else {
                    message.push_str("\nContainer filesystem will be preserved after exit.");
                }
                message.push_str(&format!("\nAttach with: docker attach {}", container_name));
                message.push_str(&format!("\nView logs: docker logs {}", container_name));

                IsolationResult {
                    success: true,
                    session_name: Some(container_name),
                    container_id: Some(container_id),
                    message,
                    ..Default::default()
                }
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                IsolationResult {
                    success: false,
                    session_name: Some(container_name),
                    message: format!("Failed to start docker container: {}", stderr),
                    ..Default::default()
                }
            }
            Err(e) => IsolationResult {
                success: false,
                session_name: Some(container_name),
                message: format!("Failed to run docker: {}", e),
                ..Default::default()
            },
        }
    } else {
        // Attached mode
        let mut args = vec!["run", "-it", "--rm", "--name", &container_name];

        if let Some(ref user) = options.user {
            args.push("--user");
            args.push(user);
        }

        if is_debug() {
            eprintln!("[DEBUG] shell: {}", shell_to_use);
        }

        args.push(&image);
        args.push(&shell_to_use);
        if let Some(flag) = shell_interactive_flag {
            args.push(flag);
        }
        args.extend(&["-c", command]);

        let status = Command::new("docker").args(&args).status();

        match status {
            Ok(s) => IsolationResult {
                success: s.success(),
                session_name: Some(container_name.clone()),
                message: format!(
                    "Docker container \"{}\" exited with code {}",
                    container_name,
                    s.code().unwrap_or(-1)
                ),
                exit_code: s.code(),
                ..Default::default()
            },
            Err(e) => IsolationResult {
                success: false,
                session_name: Some(container_name),
                message: format!("Failed to start docker: {}", e),
                ..Default::default()
            },
        }
    }
}

/// Run command in the specified isolation backend
pub fn run_isolated(backend: &str, command: &str, options: &IsolationOptions) -> IsolationResult {
    match backend {
        "screen" => run_in_screen(command, options),
        "tmux" => run_in_tmux(command, options),
        "docker" => run_in_docker(command, options),
        "ssh" => run_in_ssh(command, options),
        _ => IsolationResult {
            success: false,
            message: format!("Unknown isolation backend: {}", backend),
            ..Default::default()
        },
    }
}

/// Run command as an isolated user (without isolation backend)
pub fn run_as_isolated_user(command: &str, username: &str) -> IsolationResult {
    let status = Command::new("sudo")
        .args(["-n", "-u", username, "sh", "-c", command])
        .status();

    match status {
        Ok(s) => IsolationResult {
            success: s.success(),
            message: format!(
                "Command completed as user \"{}\" with exit code {}",
                username,
                s.code().unwrap_or(-1)
            ),
            exit_code: s.code(),
            ..Default::default()
        },
        Err(e) => IsolationResult {
            success: false,
            message: format!("Failed to run as user \"{}\": {}", username, e),
            exit_code: Some(1),
            ..Default::default()
        },
    }
}

#[path = "isolation_log.rs"]
pub mod isolation_log;
pub use self::isolation_log::{
    create_log_footer, create_log_header, create_log_path, generate_log_filename,
    get_default_docker_image, get_log_dir, get_timestamp, write_log_file, LogHeaderParams,
};

fn is_debug() -> bool {
    env::var("START_DEBUG").is_ok_and(|v| v == "1" || v == "true")
}

fn shell_escape(command: &str) -> String {
    format!("'{}'", command.replace('\'', "'\\''"))
}

#[path = "atty.rs"]
mod atty;

#[cfg(test)]
#[path = "isolation_tests.rs"]
mod tests;
