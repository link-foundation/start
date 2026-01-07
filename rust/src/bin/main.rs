//! start-command CLI
//!
//! A command-line tool for executing commands with:
//! - Natural language command aliases (via substitutions.lino)
//! - Process isolation (screen, tmux, docker, ssh)
//! - User isolation (run as separate user)
//! - Automatic failure reporting (GitHub issues)

use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{self, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;

use start_command::{
    args_parser::{
        generate_session_name, generate_uuid, get_effective_mode, has_isolation, parse_args,
    },
    create_finish_block, create_log_footer, create_log_header, create_log_path, create_start_block,
    execution_store::{
        CleanupOptions, ExecutionRecord, ExecutionRecordOptions, ExecutionStore,
        ExecutionStoreOptions,
    },
    failure_handler::{handle_failure, Config as FailureConfig},
    get_default_docker_image, get_timestamp,
    isolation::{run_as_isolated_user, run_isolated, IsolationOptions},
    output_blocks::{FinishBlockOptions, StartBlockOptions},
    status_formatter::query_status,
    substitution::{process_command, ProcessOptions},
    user_manager::{
        create_isolated_user, delete_user, get_current_user_groups, has_sudo_access,
        CreateIsolatedUserOptions, DeleteUserOptions,
    },
    write_log_file, LogHeaderParams,
};

// Global state for signal handling cleanup
// These are used to update execution status when the process is interrupted
static SIGNAL_RECEIVED: AtomicBool = AtomicBool::new(false);
static SIGNAL_EXIT_CODE: AtomicI32 = AtomicI32::new(0);
static CURRENT_EXECUTION: Mutex<Option<(ExecutionRecord, ExecutionStore)>> = Mutex::new(None);

/// Set up signal handlers for graceful cleanup on interruption
#[cfg(unix)]
fn setup_signal_handlers() {
    use std::sync::Once;
    static INIT: Once = Once::new();

    INIT.call_once(|| {
        unsafe {
            // SIGINT (Ctrl+C) - exit code 130 (128 + 2)
            libc::signal(libc::SIGINT, signal_handler as usize);
            // SIGTERM (kill command) - exit code 143 (128 + 15)
            libc::signal(libc::SIGTERM, signal_handler as usize);
            // SIGHUP (terminal closed) - exit code 129 (128 + 1)
            libc::signal(libc::SIGHUP, signal_handler as usize);
        }
    });
}

#[cfg(not(unix))]
fn setup_signal_handlers() {
    // Signal handling not supported on non-Unix platforms
}

/// Signal handler function
#[cfg(unix)]
extern "C" fn signal_handler(sig: i32) {
    // Calculate exit code based on signal (128 + signal number)
    let exit_code = 128 + sig;
    SIGNAL_EXIT_CODE.store(exit_code, Ordering::SeqCst);
    SIGNAL_RECEIVED.store(true, Ordering::SeqCst);

    // Try to clean up the current execution record
    cleanup_execution_on_signal(sig, exit_code);

    // Exit with the appropriate code
    std::process::exit(exit_code);
}

/// Clean up execution record when a signal is received
fn cleanup_execution_on_signal(signal: i32, exit_code: i32) {
    if let Ok(mut guard) = CURRENT_EXECUTION.lock() {
        if let Some((ref mut record, ref store)) = *guard {
            // Mark as completed with signal exit code
            record.complete(exit_code);
            if let Err(e) = store.save(record) {
                // Log error if verbose (can't easily check config here, so always log to stderr)
                eprintln!(
                    "\n[Tracking] Warning: Could not save execution record on signal {}: {}",
                    signal, e
                );
            }
            // Clear the record to prevent double cleanup
            *guard = None;
        }
    }
}

/// Set the current execution record for signal cleanup
fn set_current_execution(record: ExecutionRecord, store: ExecutionStore) {
    if let Ok(mut guard) = CURRENT_EXECUTION.lock() {
        *guard = Some((record, store));
    }
}

/// Clear the current execution record (call after normal completion)
fn clear_current_execution() {
    if let Ok(mut guard) = CURRENT_EXECUTION.lock() {
        *guard = None;
    }
}

/// Configuration from environment variables
struct Config {
    /// Disable automatic issue creation
    disable_auto_issue: bool,
    /// Disable log upload
    disable_log_upload: bool,
    /// Custom log directory
    log_dir: Option<String>,
    /// Verbose mode
    verbose: bool,
    /// Disable substitutions/aliases
    disable_substitutions: bool,
    /// Custom substitutions file path
    substitutions_path: Option<String>,
    /// Use command-stream library for execution
    use_command_stream: bool,
    /// Disable execution tracking
    disable_tracking: bool,
    /// Custom app folder for execution tracking
    app_folder: Option<String>,
}

impl Config {
    fn from_env() -> Self {
        // Default app folder to ~/.start-command
        let default_app_folder =
            dirs::home_dir().map(|h| h.join(".start-command").to_string_lossy().to_string());

        Self {
            disable_auto_issue: env_bool("START_DISABLE_AUTO_ISSUE"),
            disable_log_upload: env_bool("START_DISABLE_LOG_UPLOAD"),
            log_dir: env::var("START_LOG_DIR").ok(),
            verbose: env_bool("START_VERBOSE"),
            disable_substitutions: env_bool("START_DISABLE_SUBSTITUTIONS"),
            substitutions_path: env::var("START_SUBSTITUTIONS_PATH").ok(),
            use_command_stream: env_bool("START_USE_COMMAND_STREAM"),
            disable_tracking: env_bool("START_DISABLE_TRACKING"),
            app_folder: env::var("START_APP_FOLDER").ok().or(default_app_folder),
        }
    }

    /// Create an execution store based on config
    fn create_execution_store(&self) -> Option<ExecutionStore> {
        if self.disable_tracking {
            return None;
        }

        let options = ExecutionStoreOptions {
            verbose: self.verbose,
            app_folder: self.app_folder.as_ref().map(PathBuf::from),
            ..ExecutionStoreOptions::default()
        };

        Some(ExecutionStore::with_options(options))
    }
}

fn env_bool(name: &str) -> bool {
    env::var(name).is_ok_and(|v| v == "1" || v == "true")
}

fn main() {
    // Set up signal handlers for graceful cleanup on interruption
    setup_signal_handlers();

    let config = Config::from_env();
    let args: Vec<String> = env::args().skip(1).collect();

    // Handle --version flag
    let has_version_flag = !args.is_empty() && (args[0] == "--version" || args[0] == "-v");
    let has_verbose_with_version =
        has_version_flag && args.iter().any(|a| a == "--verbose" || a == "--debug");

    let version_related_args = ["--version", "-v", "--", "--verbose", "--debug"];
    let is_version_only = has_version_flag
        && args
            .iter()
            .all(|a| version_related_args.contains(&a.as_str()) || *a == args[0]);

    if has_version_flag && is_version_only {
        print_version(has_verbose_with_version || config.verbose);
        process::exit(0);
    }

    if args.is_empty() {
        print_usage();
        process::exit(0);
    }

    // Parse wrapper options and command
    let parsed = match parse_args(&args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("Error: {}", e);
            process::exit(1);
        }
    };

    let wrapper_options = parsed.wrapper_options;
    let parsed_command = parsed.command.clone();

    // Handle --status flag
    if let Some(ref uuid) = wrapper_options.status {
        handle_status_query(&config, uuid, wrapper_options.output_format.as_deref());
        process::exit(0);
    }

    // Handle --cleanup flag
    if wrapper_options.cleanup {
        handle_cleanup(&config, wrapper_options.cleanup_dry_run);
        process::exit(0);
    }

    // Check if no command was provided
    if parsed_command.is_empty() {
        eprintln!("Error: No command provided");
        print_usage();
        process::exit(1);
    }

    // Process through substitution engine (unless disabled)
    let mut command = parsed_command.clone();
    let mut substitution_result = None;

    if !config.disable_substitutions {
        let result = process_command(
            &parsed_command,
            &ProcessOptions {
                custom_lino_path: config.substitutions_path.clone(),
                verbose: config.verbose,
            },
        );

        if result.matched {
            command = result.command.clone();
            if config.verbose {
                println!("[Substitution] \"{}\" -> \"{}\"", parsed_command, command);
                println!();
            }
            substitution_result = Some(result);
        }
    }

    // Determine if we should use command-stream
    let use_command_stream = wrapper_options.use_command_stream || config.use_command_stream;

    // Generate session ID if not provided (auto-generate UUID)
    let session_id = wrapper_options
        .session_id
        .clone()
        .unwrap_or_else(generate_uuid);

    // Main execution
    if has_isolation(&wrapper_options) || wrapper_options.user {
        run_with_isolation(
            &config,
            &wrapper_options,
            &command,
            use_command_stream,
            &session_id,
        );
    } else {
        run_direct(
            &config,
            &command,
            &parsed_command,
            substitution_result.as_ref(),
            &session_id,
        );
    }
}

/// Print version information
fn print_version(verbose: bool) {
    let version = env!("CARGO_PKG_VERSION");
    println!("start-command version: {} (Rust)", version);
    println!();

    println!("OS: {}", std::env::consts::OS);
    println!("Architecture: {}", std::env::consts::ARCH);
    println!();

    // Check for installed isolation tools
    println!("Isolation tools:");

    if verbose {
        println!("[verbose] Checking isolation tools...");
    }

    // Check screen
    if let Some(version) = get_tool_version("screen", "-v", verbose) {
        println!("  screen: {}", version);
    } else {
        println!("  screen: not installed");
    }

    // Check tmux
    if let Some(version) = get_tool_version("tmux", "-V", verbose) {
        println!("  tmux: {}", version);
    } else {
        println!("  tmux: not installed");
    }

    // Check docker
    if let Some(version) = get_tool_version("docker", "--version", verbose) {
        println!("  docker: {}", version);
    } else {
        println!("  docker: not installed");
    }
}

/// Get version of an installed tool
fn get_tool_version(tool_name: &str, version_flag: &str, verbose: bool) -> Option<String> {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };

    // Check if tool exists
    let exists = Command::new(which_cmd)
        .arg(tool_name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !exists {
        if verbose {
            println!("[verbose] {}: not found in PATH", tool_name);
        }
        return None;
    }

    // Get version
    let output = Command::new(tool_name).arg(version_flag).output().ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr).trim().to_string();

    if verbose {
        println!(
            "[verbose] {} {}: exit={}, output=\"{}\"",
            tool_name,
            version_flag,
            output.status.code().unwrap_or(-1),
            &combined[..100.min(combined.len())]
        );
    }

    if combined.is_empty() {
        return None;
    }

    combined.lines().next().map(String::from)
}

/// Handle status query
fn handle_status_query(config: &Config, uuid: &str, output_format: Option<&str>) {
    let store = config.create_execution_store();
    let result = query_status(store.as_ref(), uuid, output_format);

    if result.success {
        if let Some(output) = result.output {
            println!("{}", output);
        }
    } else {
        if let Some(error) = result.error {
            eprintln!("Error: {}", error);
        }
        process::exit(1);
    }
}

/// Handle --cleanup flag
/// Cleans up stale "executing" records (processes that crashed or were killed)
fn handle_cleanup(config: &Config, dry_run: bool) {
    let store = match config.create_execution_store() {
        Some(s) => s,
        None => {
            eprintln!("Error: Execution tracking is disabled.");
            process::exit(1);
        }
    };

    let result = store.cleanup_stale(CleanupOptions {
        dry_run,
        ..Default::default()
    });

    // Print any errors
    for error in &result.errors {
        eprintln!("Error: {}", error);
    }

    if result.records.is_empty() {
        println!("No stale records found.");
        return;
    }

    if dry_run {
        println!(
            "Found {} stale record(s) that would be cleaned up:\n",
            result.records.len()
        );
    } else {
        println!("Cleaned up {} stale record(s):\n", result.cleaned);
    }

    for record in &result.records {
        // Parse start time for display
        let start_time_display = chrono::DateTime::parse_from_rfc3339(&record.start_time)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|_| record.start_time.clone());

        println!("  UUID: {}", record.uuid);
        println!("  Command: {}", record.command);
        println!("  Started: {}", start_time_display);
        println!(
            "  PID: {}",
            record.pid.map(|p| p.to_string()).unwrap_or("N/A".to_string())
        );
        println!();
    }

    if dry_run {
        println!("Run with --cleanup to actually clean up these records.");
    }
}

/// Print usage information
fn print_usage() {
    println!(
        r#"Usage: start [options] [--] <command> [args...]
       start <command> [args...]
       start --status <uuid> [--output-format <format>]

Options:
  --isolated, -i <env>  Run in isolated environment (screen, tmux, docker, ssh)
  --attached, -a        Run in attached mode (foreground)
  --detached, -d        Run in detached mode (background)
  --session, -s <name>  Session name for isolation
  --session-id <uuid>   Session UUID for tracking (auto-generated if not provided)
  --session-name <uuid> Alias for --session-id
  --image <image>       Docker image (required for docker isolation)
  --endpoint <endpoint> SSH endpoint (required for ssh isolation, e.g., user@host)
  --isolated-user, -u [name]  Create isolated user with same permissions
  --keep-user           Keep isolated user after command completes
  --keep-alive, -k      Keep isolation environment alive after command exits
  --auto-remove-docker-container  Auto-remove docker container after exit
  --use-command-stream  Use command-stream library for execution (experimental)
  --status <uuid>       Show status of execution by UUID (--output-format: links-notation|json|text)
  --cleanup             Clean up stale "executing" records (crashed/killed processes)
  --cleanup-dry-run     Show stale records that would be cleaned up (without cleaning)
  --version, -v         Show version information

Examples:
  start echo "Hello World"
  start bun test
  start --isolated tmux -- bun start
  start -i screen -d bun start
  start --isolated docker --image oven/bun:latest -- bun install
  start --isolated ssh --endpoint user@remote.server -- ls -la
  start --isolated-user -- npm test
  start -u myuser -- npm start
  start -i screen --isolated-user -- npm test
  start --status a1b2c3d4-e5f6-7890-abcd-ef1234567890
  start --status a1b2c3d4 --output-format json
  start --cleanup-dry-run
  start --cleanup

Features:
  - Logs all output to temporary directory
  - Displays timestamps and exit codes
  - Auto-reports failures for NPM packages (when gh is available)
  - Natural language command aliases (via substitutions.lino)
  - Process isolation via screen, tmux, or docker"#
    );
}

/// Run command with isolation
fn run_with_isolation(
    _config: &Config,
    wrapper_options: &start_command::WrapperOptions,
    command: &str,
    _use_command_stream: bool,
    session_id: &str,
) {
    let environment = wrapper_options.isolated.as_deref();
    let mode = get_effective_mode(wrapper_options);
    let start_time = get_timestamp();
    let start_instant = std::time::Instant::now();

    // Use default Docker image if docker isolation is selected but no image specified
    let effective_image = if environment == Some("docker") && wrapper_options.image.is_none() {
        Some(get_default_docker_image())
    } else {
        wrapper_options.image.clone()
    };

    // Create log file path
    let log_file_path = create_log_path(environment.unwrap_or("direct"));

    // Get session name
    let session_name = wrapper_options
        .session
        .clone()
        .unwrap_or_else(|| generate_session_name(Some(environment.unwrap_or("start"))));

    // Collect extra lines for start block
    let mut extra_lines: Vec<String> = Vec::new();

    // Handle --isolated-user option
    let mut created_user: Option<String> = None;

    if wrapper_options.user {
        // Check for sudo access
        if !has_sudo_access() {
            eprintln!("Error: --isolated-user requires sudo access without password.");
            eprintln!("Configure NOPASSWD in sudoers or run with appropriate permissions.");
            process::exit(1);
        }

        // Get current user groups
        let current_groups = get_current_user_groups();
        let important_groups: Vec<&str> = ["sudo", "docker", "wheel", "admin"]
            .iter()
            .copied()
            .filter(|g| current_groups.iter().any(|cg| cg == *g))
            .collect();

        extra_lines.push("[User Isolation] Creating new user...".to_string());
        if !important_groups.is_empty() {
            extra_lines.push(format!(
                "[User Isolation] Inheriting groups: {}",
                important_groups.join(", ")
            ));
        }

        // Create the isolated user
        let user_result = create_isolated_user(
            wrapper_options.user_name.as_deref(),
            &CreateIsolatedUserOptions::default(),
        );

        if !user_result.success {
            eprintln!(
                "Error: Failed to create isolated user: {}",
                user_result.message
            );
            process::exit(1);
        }

        let username = user_result.username.unwrap();
        extra_lines.push(format!("[User Isolation] Created user: {}", username));
        if let Some(groups) = &user_result.groups {
            if !groups.is_empty() {
                extra_lines.push(format!(
                    "[User Isolation] User groups: {}",
                    groups.join(", ")
                ));
            }
        }
        if wrapper_options.keep_user {
            extra_lines.push("[User Isolation] User will be kept after completion".to_string());
        }

        created_user = Some(username);
    }

    // Add isolation info to extra lines
    if let Some(env) = environment {
        extra_lines.push(format!("[Isolation] Environment: {}, Mode: {}", env, mode));
    }
    if let Some(ref session) = wrapper_options.session {
        extra_lines.push(format!("[Isolation] Session: {}", session));
    }
    if let Some(ref image) = effective_image {
        extra_lines.push(format!("[Isolation] Image: {}", image));
    }
    if let Some(ref endpoint) = wrapper_options.endpoint {
        extra_lines.push(format!("[Isolation] Endpoint: {}", endpoint));
    }
    if let Some(ref user) = created_user {
        extra_lines.push(format!("[Isolation] User: {} (isolated)", user));
    }

    // Print start block with session ID and isolation info
    let extra_lines_refs: Vec<&str> = extra_lines.iter().map(|s| s.as_str()).collect();
    println!(
        "{}",
        create_start_block(&StartBlockOptions {
            session_id,
            timestamp: &start_time,
            command,
            extra_lines: if extra_lines.is_empty() {
                None
            } else {
                Some(extra_lines_refs)
            },
            style: None,
            width: None,
        })
    );
    println!();

    // Create log header
    let mut log_content = create_log_header(&LogHeaderParams {
        command: command.to_string(),
        environment: environment.unwrap_or("direct").to_string(),
        mode: mode.to_string(),
        session_name: session_name.clone(),
        image: effective_image.clone(),
        user: created_user.clone(),
        start_time: start_time.clone(),
    });

    let result = if let Some(env) = environment {
        // Run in isolation backend
        let options = IsolationOptions {
            session: Some(session_name.clone()),
            image: effective_image.clone(),
            endpoint: wrapper_options.endpoint.clone(),
            detached: mode == "detached",
            user: created_user.clone(),
            keep_alive: wrapper_options.keep_alive,
            auto_remove_docker_container: wrapper_options.auto_remove_docker_container,
        };
        run_isolated(env, command, &options)
    } else if let Some(ref user) = created_user {
        // Run directly as the created user
        run_as_isolated_user(command, user)
    } else {
        // This shouldn't happen
        start_command::IsolationResult {
            success: false,
            message: "No isolation configuration provided".to_string(),
            ..Default::default()
        }
    };

    // Get exit code
    let exit_code = result
        .exit_code
        .unwrap_or(if result.success { 0 } else { 1 });
    let end_time = get_timestamp();

    // Add result to log
    log_content.push_str(&result.message);
    log_content.push('\n');
    log_content.push_str(&create_log_footer(&end_time, exit_code));

    // Write log file
    write_log_file(&log_file_path, &log_content);

    // Cleanup: delete the created user if we created one (unless --keep-user)
    // This output goes to stdout but NOT inside the boxes - it's operational info
    if let Some(ref user) = created_user {
        if !wrapper_options.keep_user {
            println!("[User Isolation] Cleaning up user: {}", user);
            let delete_result = delete_user(user, &DeleteUserOptions { remove_home: true });
            if delete_result.success {
                println!("[User Isolation] User deleted successfully");
            } else {
                println!("[User Isolation] Warning: {}", delete_result.message);
            }
            println!();
        } else {
            println!(
                "[User Isolation] Keeping user: {} (use 'sudo userdel -r {}' to delete)",
                user, user
            );
            println!();
        }
    }

    // Print finish block with result message inside
    // Add empty line before finish block for visual separation
    println!();
    let duration_ms = start_instant.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{}",
        create_finish_block(&FinishBlockOptions {
            session_id,
            timestamp: &end_time,
            exit_code,
            log_path: &log_file_path.to_string_lossy(),
            duration_ms: Some(duration_ms),
            result_message: Some(&result.message),
            style: None,
            width: None,
        })
    );

    process::exit(exit_code);
}

/// Run command directly (without isolation)
fn run_direct(
    config: &Config,
    command: &str,
    parsed_command: &str,
    substitution_result: Option<&start_command::SubstitutionResult>,
    session_id: &str,
) {
    let start_time = get_timestamp();
    let start_instant = std::time::Instant::now();

    // Determine display command (show substitution if applied)
    let display_command = if let Some(sub) = substitution_result {
        if sub.matched {
            format!("{} -> {}", parsed_command, command)
        } else {
            command.to_string()
        }
    } else {
        command.to_string()
    };

    // Print start block with session ID (no extra lines for direct execution)
    println!(
        "{}",
        create_start_block(&StartBlockOptions {
            session_id,
            timestamp: &start_time,
            command: &display_command,
            extra_lines: None,
            style: None,
            width: None,
        })
    );
    println!();
    let command_name = command.split_whitespace().next().unwrap_or(command);

    // Determine shell
    let is_windows = cfg!(windows);
    let shell = if is_windows {
        "powershell.exe".to_string()
    } else {
        env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    };
    let shell_args: Vec<&str> = if is_windows {
        vec!["-Command", command]
    } else {
        vec!["-c", command]
    };

    // Setup logging
    let log_dir = config
        .log_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir);
    let log_filename = format!(
        "start-command-{}-{}.log",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
        (0..6)
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
            .collect::<String>()
    );
    let log_file_path = log_dir.join(&log_filename);

    let mut log_content = String::new();

    // Create execution tracking record with provided session ID
    let execution_store = config.create_execution_store();
    let mut execution_record = ExecutionRecord::with_options(ExecutionRecordOptions {
        uuid: Some(session_id.to_string()),
        command: command.to_string(),
        log_path: Some(log_file_path.to_string_lossy().to_string()),
        pid: Some(process::id()),
        ..Default::default()
    });

    // Save initial execution record and set up signal cleanup
    if let Some(ref store) = execution_store {
        if let Err(e) = store.save(&execution_record) {
            if config.verbose {
                eprintln!(
                    "[ExecutionStore] Warning: Failed to save initial record: {}",
                    e
                );
            }
        } else {
            if config.verbose {
                println!("[ExecutionStore] Execution ID: {}", execution_record.uuid);
            }
            // Set up global state for signal cleanup
            // Clone the store since we need to pass it to the signal handler
            set_current_execution(execution_record.clone(), store.clone());
        }
    }

    // Log header
    log_content.push_str("=== Start Command Log ===\n");
    log_content.push_str(&format!("Timestamp: {}\n", start_time));
    if let Some(sub) = substitution_result {
        if sub.matched {
            log_content.push_str(&format!("Original Input: {}\n", parsed_command));
            log_content.push_str(&format!("Substituted Command: {}\n", command));
            if let Some(ref rule) = sub.rule {
                log_content.push_str(&format!("Pattern Matched: {}\n", rule.pattern));
            }
        }
    } else {
        log_content.push_str(&format!("Command: {}\n", command));
    }
    log_content.push_str(&format!("Shell: {}\n", shell));
    log_content.push_str(&format!("Platform: {}\n", std::env::consts::OS));
    log_content.push_str(&format!(
        "Working Directory: {}\n",
        env::current_dir().unwrap_or_default().display()
    ));
    log_content.push_str(&format!("{}\n\n", "=".repeat(50)));

    // Execute the command with piped stdout/stderr so we can capture and display output
    // Using spawn() instead of output() to stream data in real-time (Issue #57)
    let mut child = match Command::new(&shell)
        .args(&shell_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            let error_msg = format!("Error executing command: {}", e);
            log_content.push_str(&format!("\n{}\n", error_msg));
            eprintln!("\n{}", error_msg);

            let end_time = get_timestamp();
            log_content.push_str(&format!("\n{}\n", "=".repeat(50)));
            log_content.push_str(&format!("Finished: {}\n", end_time));
            log_content.push_str("Exit Code: 1\n");

            if let Ok(mut file) = File::create(&log_file_path) {
                let _ = file.write_all(log_content.as_bytes());
            }

            let duration_ms = start_instant.elapsed().as_secs_f64() * 1000.0;
            println!();
            println!(
                "{}",
                create_finish_block(&FinishBlockOptions {
                    session_id,
                    timestamp: &end_time,
                    exit_code: 1,
                    log_path: &log_file_path.to_string_lossy(),
                    duration_ms: Some(duration_ms),
                    result_message: None,
                    style: None,
                    width: None,
                })
            );

            process::exit(1);
        }
    };

    // Read stdout and stderr, displaying and capturing in real-time
    // Use threads to read both streams concurrently to avoid deadlocks
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_handle = std::thread::spawn(move || {
        let mut output = String::new();
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                println!("{}", line);
                output.push_str(&line);
                output.push('\n');
            }
        }
        output
    });

    let stderr_handle = std::thread::spawn(move || {
        let mut output = String::new();
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("{}", line);
                output.push_str(&line);
                output.push('\n');
            }
        }
        output
    });

    // Wait for output threads to complete
    let stdout_output = stdout_handle.join().unwrap_or_default();
    let stderr_output = stderr_handle.join().unwrap_or_default();

    // Wait for child process to exit
    let exit_code = match child.wait() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            let error_msg = format!("Error waiting for command: {}", e);
            log_content.push_str(&format!("\n{}\n", error_msg));
            eprintln!("\n{}", error_msg);
            1
        }
    };

    // Add captured output to log content
    if !stdout_output.is_empty() {
        log_content.push_str(&stdout_output);
    }
    if !stderr_output.is_empty() {
        log_content.push_str(&stderr_output);
    }

    let end_time = get_timestamp();

    // Log footer
    log_content.push_str(&format!("\n{}\n", "=".repeat(50)));
    log_content.push_str(&format!("Finished: {}\n", end_time));
    log_content.push_str(&format!("Exit Code: {}\n", exit_code));

    // Write log file
    if let Ok(mut file) = File::create(&log_file_path) {
        let _ = file.write_all(log_content.as_bytes());
    }

    // Print finish block (no result_message for direct execution)
    let duration_ms = start_instant.elapsed().as_secs_f64() * 1000.0;
    println!();
    println!(
        "{}",
        create_finish_block(&FinishBlockOptions {
            session_id,
            timestamp: &end_time,
            exit_code,
            log_path: &log_file_path.to_string_lossy(),
            duration_ms: Some(duration_ms),
            result_message: None,
            style: None,
            width: None,
        })
    );

    // Update execution record with completion status
    if let Some(ref store) = execution_store {
        execution_record.complete(exit_code);
        if let Err(e) = store.save(&execution_record) {
            if config.verbose {
                eprintln!(
                    "[ExecutionStore] Warning: Failed to save completion record: {}",
                    e
                );
            }
        }
        // Clear the global signal cleanup state since we handled completion normally
        clear_current_execution();
    }

    // If command failed, try to auto-report
    if exit_code != 0 {
        handle_failure(
            &FailureConfig {
                disable_auto_issue: config.disable_auto_issue,
                disable_log_upload: config.disable_log_upload,
                verbose: config.verbose,
            },
            command_name,
            command,
            exit_code,
            &log_file_path.to_string_lossy(),
        );
    }

    process::exit(exit_code);
}
