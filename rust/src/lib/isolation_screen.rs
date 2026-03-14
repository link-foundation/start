//! Screen-specific isolation helpers extracted from isolation.rs

use std::env;
use std::fs;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use super::{get_shell, is_debug, wrap_command_with_user, IsolationResult};

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

/// Run screen with log capture (for attached mode without TTY)
pub fn run_screen_with_log_capture(
    command: &str,
    session_name: &str,
    user: Option<&str>,
) -> IsolationResult {
    let (shell, shell_arg) = get_shell();
    let log_file = env::temp_dir().join(format!("screen-output-{}.log", session_name));
    let effective_command = wrap_command_with_user(command, user);

    let use_native_logging = supports_logfile_option();

    // Temporary screenrc file for native logging path (issue #96)
    // Setting logfile flush 0 forces screen to flush its log buffer after every write,
    // preventing output loss for quick-completing commands like `agent --version`.
    // Without this, screen buffers log writes and flushes every 10 seconds by default.
    let screenrc_file = if use_native_logging {
        let screenrc_path = env::temp_dir().join(format!("screenrc-{}", session_name));
        match fs::write(&screenrc_path, "logfile flush 0\n") {
            Ok(()) => Some(screenrc_path),
            Err(_) => None, // If we can't create the screenrc, proceed without it (best effort)
        }
    } else {
        None
    };

    let screen_args: Vec<String> = if use_native_logging {
        // Use a temporary screenrc with `logfile flush 0` to force immediate log flushing
        // (issue #96: quick commands like `agent --version` lose output without this)
        let mut args = vec!["-dmS".to_string(), session_name.to_string()];
        if let Some(ref rc_path) = screenrc_file {
            args.push("-c".to_string());
            args.push(rc_path.to_string_lossy().to_string());
        }
        args.extend([
            "-L".to_string(),
            "-Logfile".to_string(),
            log_file.to_string_lossy().to_string(),
            shell.clone(),
            shell_arg.clone(),
            effective_command.clone(),
        ]);
        args
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
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if status.is_err() {
        // Clean up screenrc temp file on error
        if let Some(ref rc_path) = screenrc_file {
            let _ = fs::remove_file(rc_path);
        }
        return IsolationResult {
            success: false,
            session_name: Some(session_name.to_string()),
            message: "Failed to start screen session".to_string(),
            ..Default::default()
        };
    }

    // Helper to read log file with retry for the tee fallback TOCTOU race condition
    // (issue #96: session may appear done in `screen -ls` before tee finishes writing)
    let read_log_with_retry = |retry_count: u32| -> Option<String> {
        let content = fs::read_to_string(&log_file).ok();
        if retry_count == 0 {
            if let Some(ref s) = content {
                if s.trim().is_empty() {
                    // Brief wait then retry once for tee path race condition
                    thread::sleep(Duration::from_millis(50));
                    return fs::read_to_string(&log_file).ok();
                }
            }
        }
        content
    };

    // Clean up temp files helper
    let cleanup = || {
        let _ = fs::remove_file(&log_file);
        if let Some(ref rc_path) = screenrc_file {
            let _ = fs::remove_file(rc_path);
        }
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
            // Session ended, read output (with retry for tee path race condition)
            let output = read_log_with_retry(0);

            // Display output
            if let Some(ref out) = output {
                if !out.trim().is_empty() {
                    print!("{}", out);
                }
            }

            // Clean up temp files
            cleanup();

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
