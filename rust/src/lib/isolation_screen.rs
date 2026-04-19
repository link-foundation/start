//! Screen-specific isolation helpers extracted from isolation.rs

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use super::{get_shell, is_debug, wrap_command_with_user, IsolationResult};
use crate::isolation::isolation_log::{get_temp_dir, wrap_command_with_log_footer};

/// Get the installed screen version
pub fn get_screen_version() -> Option<(u32, u32, u32)> {
    let output = Command::new("screen").arg("--version").output().ok()?;

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

/// Run screen with log capture using `-L` flag + screenrc directives (for attached mode without TTY).
///
/// Uses a unified approach combining the `-L` flag with screenrc directives:
/// - `-L` flag enables logging for the initial window (available on ALL screen versions)
/// - `logfile <path>` in screenrc sets the log file path (replaces `-Logfile` CLI option)
/// - `logfile flush 0` forces immediate flushing (no 10-second delay)
/// - `deflog on` enables logging for any additional windows
///
/// Key insight: `deflog on` only applies to windows created AFTER screenrc processing,
/// but the default window is created BEFORE screenrc is processed. The `-L` flag is
/// needed to enable logging for that initial window.
///
/// This replaces the previous version-dependent approach that used:
/// - `-L -Logfile` for screen >= 4.5.1 (native logging)
/// - `tee` fallback for screen < 4.5.1 (e.g., macOS bundled 4.0.3)
pub fn run_screen_with_log_capture(
    command: &str,
    session_name: &str,
    user: Option<&str>,
    log_path: Option<&Path>,
) -> IsolationResult {
    let (shell, shell_arg) = get_shell();
    let screen_temp_dir = get_temp_dir(&["isolation", "screen"]);
    let log_file = log_path
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| screen_temp_dir.join(format!("screen-output-{}.log", session_name)));
    let should_cleanup_log_file = log_path.is_none();
    let exit_code_file = screen_temp_dir.join(format!("screen-exit-{}.code", session_name));
    if let Some(parent) = log_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let log_start_offset = if log_path.is_some() {
        fs::metadata(&log_file)
            .map(|m| m.len() as usize)
            .unwrap_or(0)
    } else {
        0
    };
    let effective_command = wrap_command_with_user(command, user);

    // Check if command is an interactive shell (bare shell invocation)
    let is_bare_shell = command.trim() == "bash"
        || command.trim() == "zsh"
        || command.trim() == "sh"
        || command.trim() == "/bin/bash"
        || command.trim() == "/bin/zsh"
        || command.trim() == "/bin/sh";

    // Wrap command to capture exit code in a sidecar file
    let final_command = if is_bare_shell {
        effective_command.clone()
    } else {
        format!(
            "{}; echo $? > \"{}\"",
            effective_command,
            exit_code_file.display()
        )
    };

    // Create temporary screenrc with logging configuration.
    // Combined with the -L flag (which enables logging for the initial window),
    // these directives work on ALL screen versions (including macOS 4.00.03):
    // - `logfile <path>` sets the output log path (replaces -Logfile CLI option)
    // - `logfile flush 0` forces immediate buffer flush (prevents output loss)
    // - `deflog on` enables logging for any subsequently created windows
    let screenrc_path = screen_temp_dir.join(format!("screenrc-{}", session_name));
    let screenrc_content = format!(
        "logfile {}\nlogfile flush 0\ndeflog on\n",
        log_file.display()
    );
    if let Err(e) = fs::write(&screenrc_path, &screenrc_content) {
        if is_debug() {
            eprintln!("[screen-isolation] Failed to create screenrc: {}", e);
        }
        return IsolationResult {
            success: false,
            session_name: Some(session_name.to_string()),
            message: format!("Failed to create screenrc for logging: {}", e),
            ..Default::default()
        };
    }

    // Build screen arguments:
    //   screen -dmS <session> -L -c <screenrc> <shell> -c '<command>'
    //
    // The -L flag explicitly enables logging for the initial window.
    // Without -L, `deflog on` in screenrc only applies to windows created
    // AFTER the screenrc is processed — but the default window is created
    // BEFORE screenrc processing. This caused output to be silently lost
    // on macOS screen 4.00.03 (issue #96).
    //
    // The -L flag is available on ALL screen versions (including 4.00.03).
    // Combined with `logfile <path>` in screenrc, -L logs to our custom path
    // instead of the default `screenlog.0`.
    let screen_args: Vec<String> = if is_bare_shell {
        let mut args = vec![
            "-dmS".to_string(),
            session_name.to_string(),
            "-L".to_string(),
            "-c".to_string(),
            screenrc_path.to_string_lossy().to_string(),
        ];
        args.extend(command.split_whitespace().map(String::from));
        args
    } else {
        vec![
            "-dmS".to_string(),
            session_name.to_string(),
            "-L".to_string(),
            "-c".to_string(),
            screenrc_path.to_string_lossy().to_string(),
            shell.clone(),
            shell_arg.clone(),
            final_command.clone(),
        ]
    };

    if is_debug() {
        eprintln!("[screen-isolation] Running: screen {:?}", screen_args);
        eprintln!("[screen-isolation] screenrc: {}", screenrc_content.trim());
        eprintln!("[screen-isolation] Log file: {}", log_file.display());
        eprintln!(
            "[screen-isolation] Exit code file: {}",
            exit_code_file.display()
        );
    }

    let status = Command::new("screen")
        .args(&screen_args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if status.is_err() {
        // Clean up temp files on error
        let _ = fs::remove_file(&screenrc_path);
        return IsolationResult {
            success: false,
            session_name: Some(session_name.to_string()),
            message: "Failed to start screen session".to_string(),
            ..Default::default()
        };
    }

    // Helper to read log file with retries for race conditions.
    // Uses multiple retries with increasing delays (50ms, 100ms, 200ms).
    let read_log_with_retry = || -> Option<String> {
        let retry_delays = [50u64, 100, 200];

        let content = fs::read_to_string(&log_file)
            .ok()
            .map(|s| s.chars().skip(log_start_offset).collect::<String>());
        if let Some(ref s) = content {
            if !s.trim().is_empty() {
                return content;
            }
        }

        // Retry with increasing delays
        for (i, delay) in retry_delays.iter().enumerate() {
            if is_debug() {
                eprintln!(
                    "[screen-isolation] Log file empty, retry {}/{} after {}ms",
                    i + 1,
                    retry_delays.len(),
                    delay
                );
            }
            thread::sleep(Duration::from_millis(*delay));
            let retry_content = fs::read_to_string(&log_file)
                .ok()
                .map(|s| s.chars().skip(log_start_offset).collect::<String>());
            if let Some(ref s) = retry_content {
                if !s.trim().is_empty() {
                    return retry_content;
                }
            }
        }

        if is_debug() {
            eprintln!(
                "[screen-isolation] Log file still empty after {} retries",
                retry_delays.len()
            );
            match fs::metadata(&log_file) {
                Ok(meta) => eprintln!(
                    "[screen-isolation] Log file exists, size: {} bytes",
                    meta.len()
                ),
                Err(_) => eprintln!("[screen-isolation] Log file does not exist"),
            }
        }

        content
    };

    // Read exit code from sidecar file
    let read_exit_code = || -> i32 {
        if is_bare_shell {
            return 0;
        }
        match fs::read_to_string(&exit_code_file) {
            Ok(content) => {
                let code = content.trim().parse::<i32>().unwrap_or(0);
                if is_debug() {
                    eprintln!("[screen-isolation] Captured exit code: {}", code);
                }
                code
            }
            Err(_) => {
                if is_debug() {
                    eprintln!("[screen-isolation] Could not read exit code file, defaulting to 0");
                }
                0
            }
        }
    };

    // Clean up temp files helper
    let cleanup = || {
        if should_cleanup_log_file {
            let _ = fs::remove_file(&log_file);
        }
        let _ = fs::remove_file(&screenrc_path);
        let _ = fs::remove_file(&exit_code_file);
    };

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
            // Session ended, read output and exit code
            let output = read_log_with_retry();
            let exit_code = read_exit_code();

            // Display output
            if let Some(ref out) = output {
                if !out.trim().is_empty() {
                    print!("{}", out);
                }
            }

            // Clean up temp files
            cleanup();

            return IsolationResult {
                success: exit_code == 0,
                session_name: Some(session_name.to_string()),
                container_id: None,
                message: format!(
                    "Screen session \"{}\" exited with code {}",
                    session_name, exit_code
                ),
                exit_code: Some(exit_code),
                output,
            };
        }

        thread::sleep(check_interval);
        waited += check_interval;

        if waited >= max_wait {
            cleanup();
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

/// Start detached screen with live logging to the provided log path.
pub fn start_detached_screen_with_log_capture(
    command: &str,
    session_name: &str,
    user: Option<&str>,
    keep_alive: bool,
    log_path: Option<&Path>,
) -> IsolationResult {
    let (shell, shell_arg) = get_shell();
    let screen_temp_dir = get_temp_dir(&["isolation", "screen"]);
    let log_file = log_path
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| screen_temp_dir.join(format!("screen-output-{}.log", session_name)));
    if let Some(parent) = log_file.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let screenrc_path = screen_temp_dir.join(format!("screenrc-{}", session_name));
    let screenrc_content = format!(
        "logfile {}\nlogfile flush 0\ndeflog on\n",
        log_file.display()
    );
    if let Err(e) = fs::write(&screenrc_path, &screenrc_content) {
        if is_debug() {
            eprintln!("[screen-isolation] Failed to create screenrc: {}", e);
        }
        return IsolationResult {
            success: false,
            session_name: Some(session_name.to_string()),
            message: format!("Failed to create screenrc for logging: {}", e),
            ..Default::default()
        };
    }

    let effective_command = wrap_command_with_user(command, user);
    let final_command = wrap_command_with_log_footer(&effective_command, &shell, keep_alive);
    let screen_args = vec![
        "-dmS".to_string(),
        session_name.to_string(),
        "-L".to_string(),
        "-c".to_string(),
        screenrc_path.to_string_lossy().to_string(),
        shell.clone(),
        shell_arg,
        final_command,
    ];

    if is_debug() {
        eprintln!("[screen-isolation] Running: screen {:?}", screen_args);
        eprintln!("[screen-isolation] screenrc: {}", screenrc_content.trim());
        eprintln!("[screen-isolation] Log file: {}", log_file.display());
    }

    match Command::new("screen").args(&screen_args).status() {
        Ok(status) if status.success() => {
            let mut message = format!(
                "Command started in detached screen session: {}",
                session_name
            );
            if keep_alive {
                message.push_str("\nSession will stay alive after command completes.");
            } else {
                message.push_str("\nSession will exit automatically after command completes.");
            }
            message.push_str(&format!("\nReattach with: screen -r {}", session_name));
            message.push_str(&format!("\nLive log: {}", log_file.display()));
            IsolationResult {
                success: true,
                session_name: Some(session_name.to_string()),
                message,
                ..Default::default()
            }
        }
        Ok(status) => IsolationResult {
            success: false,
            session_name: Some(session_name.to_string()),
            message: format!(
                "Failed to start screen session (exit code {})",
                status.code().unwrap_or(-1)
            ),
            ..Default::default()
        },
        Err(e) => IsolationResult {
            success: false,
            session_name: Some(session_name.to_string()),
            message: format!("Failed to start screen session: {}", e),
            ..Default::default()
        },
    }
}
