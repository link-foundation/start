//! Logging and utility functions for isolation runners

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

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

/// Root directory for start-command temporary files.
pub fn get_temp_root() -> PathBuf {
    env::var("START_TEMP_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::temp_dir().join("start-command"))
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
    content.push_str(&format!(
        "Working Directory: {}\n",
        env::current_dir().unwrap_or_default().display()
    ));
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
    if let Some(parent) = log_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("\nWarning: Could not create log directory: {}", e);
            return false;
        }
    }
    match File::create(log_path) {
        Ok(mut file) => file.write_all(content.as_bytes()).is_ok(),
        Err(e) => {
            eprintln!("\nWarning: Could not save log file: {}", e);
            false
        }
    }
}

/// Append to a log file, creating its parent directory when needed.
pub fn append_log_file(log_path: &PathBuf, content: &str) -> bool {
    if let Some(parent) = log_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!("\nWarning: Could not create log directory: {}", e);
            return false;
        }
    }
    match OpenOptions::new().create(true).append(true).open(log_path) {
        Ok(mut file) => file.write_all(content.as_bytes()).is_ok(),
        Err(e) => {
            eprintln!("\nWarning: Could not append log file: {}", e);
            false
        }
    }
}

/// Get log directory from environment or use system temp
pub fn get_log_dir() -> PathBuf {
    env::var("START_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| get_temp_root().join("logs"))
}

/// Get a start-command temporary directory for sidecar files.
pub fn get_temp_dir(segments: &[&str]) -> PathBuf {
    let mut dir = get_temp_root().join("tmp");
    for segment in segments {
        dir.push(segment);
    }
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Create log file path
pub fn create_log_path(environment: &str) -> PathBuf {
    let log_dir = get_log_dir();
    let log_filename = generate_log_filename(environment);
    if environment == "direct" {
        log_dir.join("direct").join(log_filename)
    } else {
        log_dir
            .join("isolation")
            .join(environment)
            .join(log_filename)
    }
}

/// Create stable log file path for a specific execution UUID/session ID.
pub fn create_log_path_for_execution(environment: &str, execution_id: &str) -> PathBuf {
    if environment == "direct" {
        get_log_dir()
            .join("direct")
            .join(format!("{}.log", execution_id))
    } else {
        get_log_dir()
            .join("isolation")
            .join(environment)
            .join(format!("{}.log", execution_id))
    }
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn create_shell_log_footer_snippet() -> String {
    let date_command = "date '+%Y-%m-%d %H:%M:%S.%3N' 2>/dev/null || date '+%Y-%m-%d %H:%M:%S'";
    format!(
        "printf '\\n==================================================\\nFinished: %s\\nExit Code: %s\\n' \"$({})\" \"$__start_command_exit\"",
        date_command
    )
}

pub fn wrap_command_with_log_footer(command: &str, shell: &str, keep_alive: bool) -> String {
    let after_footer = if keep_alive {
        format!("exec {}", shell_quote(shell))
    } else {
        "exit \"$__start_command_exit\"".to_string()
    };
    format!(
        "({}); __start_command_exit=$?; {}; {}",
        command,
        create_shell_log_footer_snippet(),
        after_footer
    )
}

/// Get the default Docker image based on the host operating system
/// Returns an image that matches the current OS as closely as possible:
/// - macOS: Uses alpine (since macOS cannot run in Docker)
/// - Ubuntu/Debian: Uses ubuntu:latest
/// - Arch Linux: Uses archlinux:latest
/// - Other Linux: Uses the detected distro or alpine as fallback
/// - Windows: Uses alpine (Windows containers have limited support)
pub fn get_default_docker_image() -> String {
    #[cfg(target_os = "macos")]
    {
        // macOS cannot run in Docker containers, use alpine as lightweight alternative
        return "alpine:latest".to_string();
    }

    #[cfg(target_os = "windows")]
    {
        // Windows containers have limited support, use alpine for Linux containers
        return "alpine:latest".to_string();
    }

    #[cfg(target_os = "linux")]
    {
        use std::fs;
        // Try to detect the Linux distribution
        if let Ok(os_release) = fs::read_to_string("/etc/os-release") {
            // Check for Ubuntu
            if os_release.contains("ID=ubuntu")
                || os_release.contains("ID_LIKE=ubuntu")
                || os_release.contains("ID_LIKE=debian ubuntu")
            {
                return "ubuntu:latest".to_string();
            }

            // Check for Debian
            if os_release.contains("ID=debian") || os_release.contains("ID_LIKE=debian") {
                return "debian:latest".to_string();
            }

            // Check for Arch Linux
            if os_release.contains("ID=arch") || os_release.contains("ID_LIKE=arch") {
                return "archlinux:latest".to_string();
            }

            // Check for Fedora
            if os_release.contains("ID=fedora") {
                return "fedora:latest".to_string();
            }

            // Check for CentOS/RHEL
            if os_release.contains("ID=centos")
                || os_release.contains("ID=rhel")
                || os_release.contains("ID_LIKE=rhel")
            {
                return "centos:latest".to_string();
            }

            // Check for Alpine
            if os_release.contains("ID=alpine") {
                return "alpine:latest".to_string();
            }
        }

        // Default fallback: use alpine as a lightweight, universal option
        "alpine:latest".to_string()
    }

    // Fallback for other platforms
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "alpine:latest".to_string()
    }
}
