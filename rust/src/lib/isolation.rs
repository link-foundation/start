//! Isolation Runners for start-command
//!
//! Provides execution of commands in various isolated environments:
//! - screen: GNU Screen terminal multiplexer
//! - tmux: tmux terminal multiplexer
//! - docker: Docker containers
//! - ssh: Remote SSH execution

use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::args_parser::generate_session_name;

/// Result of an isolation run
#[derive(Debug)]
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

impl Default for IsolationResult {
    fn default() -> Self {
        Self {
            success: false,
            session_name: None,
            container_id: None,
            message: String::new(),
            exit_code: None,
            output: None,
        }
    }
}

/// Options for isolation
#[derive(Debug, Default, Clone)]
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

/// Get the installed screen version
pub fn get_screen_version() -> Option<(u32, u32, u32)> {
    let output = Command::new("screen")
        .arg("--version")
        .output()
        .ok()?;

    let output_str = String::from_utf8_lossy(&output.stdout);
    let stderr_str = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", output_str, stderr_str);

    // Match patterns like "4.09.01", "4.00.03", "4.5.1"
    let re = regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").ok()?;
    let caps = re.captures(&combined)?;

    Some((
        caps.get(1)?.as_str().parse().ok()?,
        caps.get(2)?.as_str().parse().ok()?,
        caps.get(3)?.as_str().parse().ok()?,
    ))
}

/// Check if screen supports the -Logfile option (added in 4.5.1)
pub fn supports_logfile_option() -> bool {
    match get_screen_version() {
        Some((major, minor, patch)) => {
            if major > 4 {
                return true;
            }
            if major < 4 {
                return false;
            }
            // major == 4
            if minor > 5 {
                return true;
            }
            if minor < 5 {
                return false;
            }
            // minor == 5
            patch >= 1
        }
        None => false,
    }
}

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
        run_screen_with_log_capture(command, &session_name, options.user.as_deref())
    }
}

/// Run screen with log capture (for attached mode without TTY)
fn run_screen_with_log_capture(
    command: &str,
    session_name: &str,
    user: Option<&str>,
) -> IsolationResult {
    let (shell, shell_arg) = get_shell();
    let log_file = env::temp_dir().join(format!("screen-output-{}.log", session_name));
    let effective_command = wrap_command_with_user(command, user);

    let use_native_logging = supports_logfile_option();

    let screen_args: Vec<String> = if use_native_logging {
        vec![
            "-dmS".to_string(),
            session_name.to_string(),
            "-L".to_string(),
            "-Logfile".to_string(),
            log_file.to_string_lossy().to_string(),
            shell.clone(),
            shell_arg.clone(),
            effective_command.clone(),
        ]
    } else {
        // Use tee fallback for older screen versions
        let tee_command = format!(
            "({}) 2>&1 | tee \"{}\"",
            effective_command,
            log_file.display()
        );
        vec![
            "-dmS".to_string(),
            session_name.to_string(),
            shell.clone(),
            shell_arg.clone(),
            tee_command,
        ]
    };

    if is_debug() {
        eprintln!("[DEBUG] Running: screen {:?}", screen_args);
    }

    let status = Command::new("screen")
        .args(&screen_args)
        .status();

    if status.is_err() {
        return IsolationResult {
            success: false,
            session_name: Some(session_name.to_string()),
            message: "Failed to start screen session".to_string(),
            ..Default::default()
        };
    }

    // Poll for session completion
    let max_wait = Duration::from_secs(300);
    let check_interval = Duration::from_millis(100);
    let mut waited = Duration::ZERO;

    loop {
        // Check if session still exists
        let sessions = Command::new("screen")
            .arg("-ls")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        if !sessions.contains(session_name) {
            // Session ended, read output
            let output = fs::read_to_string(&log_file).ok();

            // Display output
            if let Some(ref out) = output {
                if !out.trim().is_empty() {
                    print!("{}", out);
                }
            }

            // Clean up log file
            let _ = fs::remove_file(&log_file);

            return IsolationResult {
                success: true,
                session_name: Some(session_name.to_string()),
                container_id: None,
                message: format!("Screen session \"{}\" exited with code 0", session_name),
                exit_code: Some(0),
                output,
            };
        }

        thread::sleep(check_interval);
        waited += check_interval;

        if waited >= max_wait {
            return IsolationResult {
                success: false,
                session_name: Some(session_name.to_string()),
                message: format!(
                    "Screen session \"{}\" timed out after {} seconds",
                    session_name,
                    max_wait.as_secs()
                ),
                exit_code: Some(1),
                ..Default::default()
            };
        }
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
                let mut message = format!(
                    "Command started in detached tmux session: {}",
                    session_name
                );
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

    if options.detached {
        // Detached mode: run in background on remote
        let remote_command = format!("nohup {} > /tmp/{}.log 2>&1 &", command, session_name);

        let status = Command::new("ssh")
            .args([&endpoint, &remote_command])
            .status();

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
        // Attached mode
        let status = Command::new("ssh")
            .args([&endpoint, command])
            .status();

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

/// Run command in Docker container
pub fn run_in_docker(command: &str, options: &IsolationOptions) -> IsolationResult {
    if !is_command_available("docker") {
        return IsolationResult {
            success: false,
            message: "docker is not installed. Install Docker from https://docs.docker.com/get-docker/".to_string(),
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

    let container_name = options
        .session
        .clone()
        .unwrap_or_else(|| generate_session_name(Some("docker")));

    let (_, _) = get_shell();

    if options.detached {
        let effective_command = if options.keep_alive {
            format!("{}; exec /bin/sh", command)
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

        args.extend(&[&image, "/bin/sh", "-c", &effective_command]);

        if is_debug() {
            eprintln!("[DEBUG] Running: docker {:?}", args);
        }

        match Command::new("docker").args(&args).output() {
            Ok(output) if output.status.success() => {
                let container_id = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .to_string();

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
                    message.push_str("\nContainer will exit automatically after command completes.");
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

        args.extend(&[&image, "/bin/sh", "-c", command]);

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

/// Generate timestamp for logging
pub fn get_timestamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

/// Generate unique log filename
pub fn generate_log_filename(environment: &str) -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let random: String = (0..6)
        .map(|_| {
            let idx = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
                % 36) as u8;
            if idx < 10 {
                (b'0' + idx) as char
            } else {
                (b'a' + idx - 10) as char
            }
        })
        .collect();
    format!("start-command-{}-{}-{}.log", environment, timestamp, random)
}

/// Log header parameters
#[derive(Debug)]
pub struct LogHeaderParams {
    pub command: String,
    pub environment: String,
    pub mode: String,
    pub session_name: String,
    pub image: Option<String>,
    pub user: Option<String>,
    pub start_time: String,
}

/// Create log content header
pub fn create_log_header(params: &LogHeaderParams) -> String {
    let mut content = String::new();
    content.push_str("=== Start Command Log ===\n");
    content.push_str(&format!("Timestamp: {}\n", params.start_time));
    content.push_str(&format!("Command: {}\n", params.command));
    content.push_str(&format!("Environment: {}\n", params.environment));
    content.push_str(&format!("Mode: {}\n", params.mode));
    content.push_str(&format!("Session: {}\n", params.session_name));
    if let Some(ref image) = params.image {
        content.push_str(&format!("Image: {}\n", image));
    }
    if let Some(ref user) = params.user {
        content.push_str(&format!("User: {}\n", user));
    }
    content.push_str(&format!("Platform: {}\n", std::env::consts::OS));
    content.push_str(&format!("Working Directory: {}\n", env::current_dir().unwrap_or_default().display()));
    content.push_str(&format!("{}\n\n", "=".repeat(50)));
    content
}

/// Create log content footer
pub fn create_log_footer(end_time: &str, exit_code: i32) -> String {
    let mut content = String::new();
    content.push_str(&format!("\n{}\n", "=".repeat(50)));
    content.push_str(&format!("Finished: {}\n", end_time));
    content.push_str(&format!("Exit Code: {}\n", exit_code));
    content
}

/// Write log file
pub fn write_log_file(log_path: &PathBuf, content: &str) -> bool {
    match File::create(log_path) {
        Ok(mut file) => file.write_all(content.as_bytes()).is_ok(),
        Err(e) => {
            eprintln!("\nWarning: Could not save log file: {}", e);
            false
        }
    }
}

/// Get log directory from environment or use system temp
pub fn get_log_dir() -> PathBuf {
    env::var("START_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir())
}

/// Create log file path
pub fn create_log_path(environment: &str) -> PathBuf {
    let log_dir = get_log_dir();
    let log_filename = generate_log_filename(environment);
    log_dir.join(log_filename)
}

fn is_debug() -> bool {
    env::var("START_DEBUG").map_or(false, |v| v == "1" || v == "true")
}

// Stub for atty crate functionality
mod atty {
    pub enum Stream {
        Stdin,
        Stdout,
    }

    pub fn is(_stream: Stream) -> bool {
        // Simple check using isatty
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            match _stream {
                Stream::Stdin => unsafe { libc::isatty(std::io::stdin().as_raw_fd()) != 0 },
                Stream::Stdout => unsafe { libc::isatty(std::io::stdout().as_raw_fd()) != 0 },
            }
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_command_available() {
        // These should exist on most systems
        assert!(is_command_available("ls") || is_command_available("dir"));
    }

    #[test]
    fn test_get_shell() {
        let (shell, arg) = get_shell();
        assert!(!shell.is_empty());
        assert!(!arg.is_empty());
    }

    #[test]
    fn test_wrap_command_with_user() {
        let cmd = wrap_command_with_user("echo hello", None);
        assert_eq!(cmd, "echo hello");

        let cmd = wrap_command_with_user("echo hello", Some("testuser"));
        assert!(cmd.contains("sudo"));
        assert!(cmd.contains("testuser"));
    }

    #[test]
    fn test_get_timestamp() {
        let ts = get_timestamp();
        assert!(ts.contains("-"));
        assert!(ts.contains(":"));
    }

    #[test]
    fn test_generate_log_filename() {
        let name = generate_log_filename("test");
        assert!(name.starts_with("start-command-test-"));
        assert!(name.ends_with(".log"));
    }

    #[test]
    fn test_create_log_path() {
        let path = create_log_path("test");
        assert!(path.to_string_lossy().contains("start-command-test-"));
    }
}
