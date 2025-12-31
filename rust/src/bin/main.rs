//! start-command CLI
//!
//! A command-line tool for executing commands with:
//! - Natural language command aliases (via substitutions.lino)
//! - Process isolation (screen, tmux, docker, ssh)
//! - User isolation (run as separate user)
//! - Automatic failure reporting (GitHub issues)

use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::{self, Command, Stdio};

use start_command::{
    args_parser::{generate_session_name, get_effective_mode, has_isolation, parse_args},
    create_log_footer, create_log_header, create_log_path,
    execution_store::{ExecutionRecord, ExecutionStore, ExecutionStoreOptions},
    failure_handler::{handle_failure, Config as FailureConfig},
    get_timestamp,
    isolation::{run_as_isolated_user, run_isolated, IsolationOptions},
    substitution::{process_command, ProcessOptions},
    user_manager::{
        create_isolated_user, delete_user, get_current_user_groups, has_sudo_access,
        CreateIsolatedUserOptions, DeleteUserOptions,
    },
    write_log_file, LogHeaderParams,
};

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
        Self {
            disable_auto_issue: env_bool("START_DISABLE_AUTO_ISSUE"),
            disable_log_upload: env_bool("START_DISABLE_LOG_UPLOAD"),
            log_dir: env::var("START_LOG_DIR").ok(),
            verbose: env_bool("START_VERBOSE"),
            disable_substitutions: env_bool("START_DISABLE_SUBSTITUTIONS"),
            substitutions_path: env::var("START_SUBSTITUTIONS_PATH").ok(),
            use_command_stream: env_bool("START_USE_COMMAND_STREAM"),
            disable_tracking: env_bool("START_DISABLE_TRACKING"),
            app_folder: env::var("START_APP_FOLDER").ok(),
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

    // Main execution
    if has_isolation(&wrapper_options) || wrapper_options.user {
        run_with_isolation(&config, &wrapper_options, &command, use_command_stream);
    } else {
        run_direct(
            &config,
            &command,
            &parsed_command,
            substitution_result.as_ref(),
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

/// Print usage information
fn print_usage() {
    println!(
        r#"Usage: start [options] [--] <command> [args...]
       start <command> [args...]

Options:
  --isolated, -i <env>  Run in isolated environment (screen, tmux, docker, ssh)
  --attached, -a        Run in attached mode (foreground)
  --detached, -d        Run in detached mode (background)
  --session, -s <name>  Session name for isolation
  --image <image>       Docker image (required for docker isolation)
  --endpoint <endpoint> SSH endpoint (required for ssh isolation, e.g., user@host)
  --isolated-user, -u [name]  Create isolated user with same permissions
  --keep-user           Keep isolated user after command completes
  --keep-alive, -k      Keep isolation environment alive after command exits
  --auto-remove-docker-container  Auto-remove docker container after exit
  --use-command-stream  Use command-stream library for execution (experimental)
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
) {
    let environment = wrapper_options.isolated.as_deref();
    let mode = get_effective_mode(wrapper_options);
    let start_time = get_timestamp();

    // Create log file path
    let log_file_path = create_log_path(environment.unwrap_or("direct"));

    // Get session name
    let session_name = wrapper_options
        .session
        .clone()
        .unwrap_or_else(|| generate_session_name(Some(environment.unwrap_or("start"))));

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

        println!("[User Isolation] Creating new user with same permissions...");
        if !important_groups.is_empty() {
            println!(
                "[User Isolation] Inheriting groups: {}",
                important_groups.join(", ")
            );
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
        println!("[User Isolation] Created user: {}", username);
        if let Some(groups) = &user_result.groups {
            if !groups.is_empty() {
                println!("[User Isolation] User groups: {}", groups.join(", "));
            }
        }
        if wrapper_options.keep_user {
            println!("[User Isolation] User will be kept after command completes");
        }
        println!();

        created_user = Some(username);
    }

    // Print start message
    println!("[{}] Starting: {}", start_time, command);
    println!();

    // Log isolation info
    if let Some(env) = environment {
        println!("[Isolation] Environment: {}, Mode: {}", env, mode);
    }
    if let Some(ref session) = wrapper_options.session {
        println!("[Isolation] Session: {}", session);
    }
    if let Some(ref image) = wrapper_options.image {
        println!("[Isolation] Image: {}", image);
    }
    if let Some(ref endpoint) = wrapper_options.endpoint {
        println!("[Isolation] Endpoint: {}", endpoint);
    }
    if let Some(ref user) = created_user {
        println!("[Isolation] User: {} (isolated)", user);
    }
    println!();

    // Create log header
    let mut log_content = create_log_header(&LogHeaderParams {
        command: command.to_string(),
        environment: environment.unwrap_or("direct").to_string(),
        mode: mode.to_string(),
        session_name: session_name.clone(),
        image: wrapper_options.image.clone(),
        user: created_user.clone(),
        start_time: start_time.clone(),
    });

    let result = if let Some(env) = environment {
        // Run in isolation backend
        let options = IsolationOptions {
            session: Some(session_name.clone()),
            image: wrapper_options.image.clone(),
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

    // Print result
    println!();
    println!("{}", result.message);
    println!();
    println!("[{}] Finished", end_time);
    println!("Exit code: {}", exit_code);
    println!("Log saved: {}", log_file_path.display());

    // Cleanup: delete the created user if we created one (unless --keep-user)
    if let Some(ref user) = created_user {
        if !wrapper_options.keep_user {
            println!();
            println!("[User Isolation] Cleaning up user: {}", user);
            let delete_result = delete_user(user, &DeleteUserOptions { remove_home: true });
            if delete_result.success {
                println!("[User Isolation] User deleted successfully");
            } else {
                println!("[User Isolation] Warning: {}", delete_result.message);
            }
        } else {
            println!();
            println!(
                "[User Isolation] Keeping user: {} (use 'sudo userdel -r {}' to delete)",
                user, user
            );
        }
    }

    process::exit(exit_code);
}

/// Run command directly (without isolation)
fn run_direct(
    config: &Config,
    command: &str,
    parsed_command: &str,
    substitution_result: Option<&start_command::SubstitutionResult>,
) {
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
    let start_time = get_timestamp();

    // Create execution tracking record
    let execution_store = config.create_execution_store();
    let mut execution_record = ExecutionRecord::new(command);
    execution_record.log_path = log_file_path.to_string_lossy().to_string();
    execution_record.pid = Some(process::id());

    // Save initial execution record
    if let Some(ref store) = execution_store {
        if let Err(e) = store.save(&execution_record) {
            if config.verbose {
                eprintln!(
                    "[ExecutionStore] Warning: Failed to save initial record: {}",
                    e
                );
            }
        } else if config.verbose {
            println!("[ExecutionStore] Execution ID: {}", execution_record.uuid);
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

    // Print start message
    if let Some(sub) = substitution_result {
        if sub.matched {
            println!("[{}] Input: {}", start_time, parsed_command);
            println!("[{}] Executing: {}", start_time, command);
        } else {
            println!("[{}] Starting: {}", start_time, command);
        }
    } else {
        println!("[{}] Starting: {}", start_time, command);
    }
    println!();

    // Execute the command
    let output = Command::new(&shell)
        .args(&shell_args)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .output();

    let exit_code = match output {
        Ok(output) => {
            let code = output.status.code().unwrap_or(1);

            // Capture any output
            if !output.stdout.is_empty() {
                log_content.push_str(&String::from_utf8_lossy(&output.stdout));
            }
            if !output.stderr.is_empty() {
                log_content.push_str(&String::from_utf8_lossy(&output.stderr));
            }

            code
        }
        Err(e) => {
            let error_msg = format!("Error executing command: {}", e);
            log_content.push_str(&format!("\n{}\n", error_msg));
            eprintln!("\n{}", error_msg);
            1
        }
    };

    let end_time = get_timestamp();

    // Log footer
    log_content.push_str(&format!("\n{}\n", "=".repeat(50)));
    log_content.push_str(&format!("Finished: {}\n", end_time));
    log_content.push_str(&format!("Exit Code: {}\n", exit_code));

    // Write log file
    if let Ok(mut file) = File::create(&log_file_path) {
        let _ = file.write_all(log_content.as_bytes());
    }

    // Print footer
    println!();
    println!("[{}] Finished", end_time);
    println!("Exit code: {}", exit_code);
    println!("Log saved: {}", log_file_path.display());

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
