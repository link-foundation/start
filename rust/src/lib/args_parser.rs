//! Argument Parser for start-command wrapper options
//!
//! Supports two syntax patterns:
//! 1. $ [wrapper-options] -- [command-options]
//! 2. $ [wrapper-options] command [command-options]
//!
//! Wrapper Options:
//! --isolated, -i <backend>         Run in isolated environment (screen, tmux, docker, ssh)
//! --attached, -a                   Run in attached mode (foreground)
//! --detached, -d                   Run in detached mode (background)
//! --session, -s <name>             Session name for isolation
//! --image <image>                  Docker image (optional, defaults to OS-matched image)
//! --endpoint <endpoint>            SSH endpoint (required for ssh isolation, e.g., user@host)
//! --isolated-user, -u [username]   Create isolated user with same permissions
//! --keep-user                      Keep isolated user after command completes
//! --keep-alive, -k                 Keep isolation environment alive after command exits
//! --auto-remove-docker-container   Automatically remove docker container after exit
//! --shell <shell>                  Shell to use in isolation environments: auto, bash, zsh, sh (default: auto)
//! --list                           List all tracked command executions

use std::env;

use crate::isolation::get_default_docker_image;

/// Valid isolation backends
pub const VALID_BACKENDS: [&str; 4] = ["screen", "tmux", "docker", "ssh"];

/// Valid shell options for --shell
pub const VALID_SHELLS: [&str; 4] = ["auto", "bash", "zsh", "sh"];

/// Valid output formats for query output
pub const VALID_OUTPUT_FORMATS: [&str; 3] = ["links-notation", "json", "text"];

/// UUID v4 regex pattern for validation
const UUID_REGEX: &str = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/// Check if a string is a valid UUID v4
pub fn is_valid_uuid(s: &str) -> bool {
    regex::Regex::new(UUID_REGEX)
        .map(|re| re.is_match(&s.to_lowercase()))
        .unwrap_or(false)
}

/// Generate a UUID v4
pub fn generate_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Wrapper options parsed from command line
#[derive(Debug, Clone)]
pub struct WrapperOptions {
    /// Isolation backend: screen, tmux, docker, ssh
    pub isolated: Option<String>,
    /// Run in attached mode
    pub attached: bool,
    /// Run in detached mode
    pub detached: bool,
    /// Session name
    pub session: Option<String>,
    /// Session ID (UUID) for tracking - auto-generated if not provided
    pub session_id: Option<String>,
    /// Docker image
    pub image: Option<String>,
    /// SSH endpoint (e.g., user@host)
    pub endpoint: Option<String>,
    /// Create isolated user
    pub user: bool,
    /// Optional custom username for isolated user
    pub user_name: Option<String>,
    /// Keep isolated user after command completes
    pub keep_user: bool,
    /// Keep environment alive after command exits
    pub keep_alive: bool,
    /// Auto-remove docker container after exit
    pub auto_remove_docker_container: bool,
    /// Shell to use in isolation environments: auto, bash, zsh, sh
    pub shell: String,
    /// Use command-stream library for command execution
    pub use_command_stream: bool,
    /// UUID to query status for
    pub status: Option<String>,
    /// List all tracked execution records
    pub list: bool,
    /// Output format for status/list (links-notation, json, text)
    pub output_format: Option<String>,
    /// Clean up stale "executing" records
    pub cleanup: bool,
    /// Show what would be cleaned without actually cleaning
    pub cleanup_dry_run: bool,
}

impl Default for WrapperOptions {
    fn default() -> Self {
        WrapperOptions {
            isolated: None,
            attached: false,
            detached: false,
            session: None,
            session_id: None,
            image: None,
            endpoint: None,
            user: false,
            user_name: None,
            keep_user: false,
            keep_alive: false,
            auto_remove_docker_container: false,
            shell: "auto".to_string(),
            use_command_stream: false,
            status: None,
            list: false,
            output_format: None,
            cleanup: false,
            cleanup_dry_run: false,
        }
    }
}

/// Result of parsing arguments
#[derive(Debug)]
pub struct ParsedArgs {
    /// Wrapper options
    pub wrapper_options: WrapperOptions,
    /// The command to execute (joined with spaces)
    pub command: String,
    /// Raw command arguments
    pub raw_command: Vec<String>,
}

/// Parse command line arguments into wrapper options and command
pub fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut wrapper_options = WrapperOptions::default();
    let mut command_args: Vec<String> = Vec::new();

    // Find the separator '--' or detect where command starts
    let separator_index = args.iter().position(|a| a == "--");

    if let Some(sep_idx) = separator_index {
        // Pattern 1: explicit separator
        let wrapper_args: Vec<String> = args[..sep_idx].to_vec();
        command_args = args[sep_idx + 1..].to_vec();
        parse_wrapper_args(&wrapper_args, &mut wrapper_options)?;
    } else {
        // Pattern 2: parse until we hit a non-option argument
        let mut i = 0;
        while i < args.len() {
            let arg = &args[i];
            if arg.starts_with('-') {
                match parse_option(args, i, &mut wrapper_options)? {
                    0 => {
                        // Unknown option, treat rest as command
                        command_args = args[i..].to_vec();
                        break;
                    }
                    consumed => {
                        i += consumed;
                    }
                }
            } else {
                // Non-option argument, rest is command
                command_args = args[i..].to_vec();
                break;
            }
        }
    }

    // Validate options and apply defaults
    validate_options(&mut wrapper_options)?;

    Ok(ParsedArgs {
        wrapper_options,
        command: command_args.join(" "),
        raw_command: command_args,
    })
}

/// Parse wrapper arguments
fn parse_wrapper_args(args: &[String], options: &mut WrapperOptions) -> Result<(), String> {
    let mut i = 0;
    while i < args.len() {
        match parse_option(args, i, options)? {
            0 => {
                // Unknown wrapper option - just skip in debug mode
                if env::var("START_DEBUG").is_ok_and(|v| v == "1" || v == "true") {
                    eprintln!("Unknown wrapper option: {}", args[i]);
                }
                i += 1;
            }
            consumed => {
                i += consumed;
            }
        }
    }
    Ok(())
}

/// Parse a single option from args array
/// Returns number of arguments consumed (0 if not recognized)
fn parse_option(
    args: &[String],
    index: usize,
    options: &mut WrapperOptions,
) -> Result<usize, String> {
    let arg = &args[index];

    // --isolated or -i
    if arg == "--isolated" || arg == "-i" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.isolated = Some(args[index + 1].to_lowercase());
            return Ok(2);
        } else {
            return Err(format!(
                "Option {} requires a backend argument (screen, tmux, docker, ssh)",
                arg
            ));
        }
    }

    // --isolated=<value>
    if arg.starts_with("--isolated=") {
        options.isolated = Some(arg.split('=').nth(1).unwrap_or("").to_lowercase());
        return Ok(1);
    }

    // --attached or -a
    if arg == "--attached" || arg == "-a" {
        options.attached = true;
        return Ok(1);
    }

    // --detached or -d
    if arg == "--detached" || arg == "-d" {
        options.detached = true;
        return Ok(1);
    }

    // --session or -s
    if arg == "--session" || arg == "-s" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.session = Some(args[index + 1].clone());
            return Ok(2);
        } else {
            return Err(format!("Option {} requires a session name argument", arg));
        }
    }

    // --session=<value>
    if arg.starts_with("--session=") {
        options.session = Some(arg.split('=').nth(1).unwrap_or("").to_string());
        return Ok(1);
    }

    // --image (for docker)
    if arg == "--image" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.image = Some(args[index + 1].clone());
            return Ok(2);
        } else {
            return Err(format!("Option {} requires an image name argument", arg));
        }
    }

    // --image=<value>
    if arg.starts_with("--image=") {
        options.image = Some(arg.split('=').nth(1).unwrap_or("").to_string());
        return Ok(1);
    }

    // --endpoint (for ssh)
    if arg == "--endpoint" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.endpoint = Some(args[index + 1].clone());
            return Ok(2);
        } else {
            return Err(format!("Option {} requires an endpoint argument", arg));
        }
    }

    // --endpoint=<value>
    if arg.starts_with("--endpoint=") {
        options.endpoint = Some(arg.split('=').nth(1).unwrap_or("").to_string());
        return Ok(1);
    }

    // --isolated-user or -u [optional-username]
    if arg == "--isolated-user" || arg == "-u" {
        options.user = true;
        // Check if next arg is an optional username (not starting with -)
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            let next_arg = &args[index + 1];
            // Check if next arg matches username format
            let username_regex = regex::Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap();
            if username_regex.is_match(next_arg) && next_arg.len() <= 32 {
                options.user_name = Some(next_arg.clone());
                return Ok(2);
            }
        }
        return Ok(1);
    }

    // --isolated-user=<value>
    if arg.starts_with("--isolated-user=") {
        options.user = true;
        options.user_name = Some(arg.split('=').nth(1).unwrap_or("").to_string());
        return Ok(1);
    }

    // --keep-user
    if arg == "--keep-user" {
        options.keep_user = true;
        return Ok(1);
    }

    // --keep-alive or -k
    if arg == "--keep-alive" || arg == "-k" {
        options.keep_alive = true;
        return Ok(1);
    }

    // --auto-remove-docker-container
    if arg == "--auto-remove-docker-container" {
        options.auto_remove_docker_container = true;
        return Ok(1);
    }

    // --shell <shell>
    if arg == "--shell" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.shell = args[index + 1].to_lowercase();
            return Ok(2);
        } else {
            return Err(format!(
                "Option {} requires a shell argument (auto, bash, zsh, sh)",
                arg
            ));
        }
    }

    // --shell=<value>
    if arg.starts_with("--shell=") {
        options.shell = arg.split('=').nth(1).unwrap_or("").to_lowercase();
        return Ok(1);
    }

    // --use-command-stream
    if arg == "--use-command-stream" {
        options.use_command_stream = true;
        return Ok(1);
    }

    // --session-id or --session-name (alias) <uuid>
    if arg == "--session-id" || arg == "--session-name" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.session_id = Some(args[index + 1].clone());
            return Ok(2);
        } else {
            return Err(format!("Option {} requires a UUID argument", arg));
        }
    }

    // --session-id=<value> or --session-name=<value>
    if arg.starts_with("--session-id=") || arg.starts_with("--session-name=") {
        options.session_id = Some(arg.split('=').nth(1).unwrap_or("").to_string());
        return Ok(1);
    }

    // --status <uuid-or-session-name>
    if arg == "--status" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.status = Some(args[index + 1].clone());
            return Ok(2);
        } else {
            return Err(format!(
                "Option {} requires a UUID or session name argument",
                arg
            ));
        }
    }

    // --status=<value>
    if arg.starts_with("--status=") {
        options.status = Some(arg.split('=').nth(1).unwrap_or("").to_string());
        return Ok(1);
    }

    // --list
    if arg == "--list" {
        options.list = true;
        return Ok(1);
    }

    // --output-format <format>
    if arg == "--output-format" {
        if index + 1 < args.len() && !args[index + 1].starts_with('-') {
            options.output_format = Some(args[index + 1].to_lowercase());
            return Ok(2);
        } else {
            return Err(format!("Option {} requires a format argument", arg));
        }
    }

    // --output-format=<value>
    if arg.starts_with("--output-format=") {
        options.output_format = Some(arg.split('=').nth(1).unwrap_or("").to_lowercase());
        return Ok(1);
    }

    // --cleanup
    if arg == "--cleanup" {
        options.cleanup = true;
        return Ok(1);
    }

    // --cleanup-dry-run
    if arg == "--cleanup-dry-run" {
        options.cleanup = true;
        options.cleanup_dry_run = true;
        return Ok(1);
    }

    // Not a recognized wrapper option
    Ok(0)
}

/// Validate parsed options and apply defaults
pub fn validate_options(options: &mut WrapperOptions) -> Result<(), String> {
    // Check attached and detached conflict
    if options.attached && options.detached {
        return Err(
            "Cannot use both --attached and --detached at the same time. Please choose only one mode."
                .to_string(),
        );
    }

    // Validate isolation backend
    if let Some(ref backend) = options.isolated {
        if !VALID_BACKENDS.contains(&backend.as_str()) {
            return Err(format!(
                "Invalid isolation backend: \"{}\". Valid options are: {}",
                backend,
                VALID_BACKENDS.join(", ")
            ));
        }

        // Docker uses --image or defaults to OS-matched image
        if backend == "docker" && options.image.is_none() {
            options.image = Some(get_default_docker_image());
        }

        // SSH requires --endpoint
        if backend == "ssh" && options.endpoint.is_none() {
            return Err(
                "SSH isolation requires --endpoint option to specify the remote server (e.g., user@host)"
                    .to_string(),
            );
        }
    }

    // Session name is only valid with isolation
    if options.session.is_some() && options.isolated.is_none() {
        return Err("--session option is only valid with --isolated".to_string());
    }

    // Image is only valid with docker
    if options.image.is_some() && options.isolated.as_deref() != Some("docker") {
        return Err("--image option is only valid with --isolated docker".to_string());
    }

    // Endpoint is only valid with ssh
    if options.endpoint.is_some() && options.isolated.as_deref() != Some("ssh") {
        return Err("--endpoint option is only valid with --isolated ssh".to_string());
    }

    // Keep-alive is only valid with isolation
    if options.keep_alive && options.isolated.is_none() {
        return Err("--keep-alive option is only valid with --isolated".to_string());
    }

    // Auto-remove-docker-container is only valid with docker isolation
    if options.auto_remove_docker_container && options.isolated.as_deref() != Some("docker") {
        return Err(
            "--auto-remove-docker-container option is only valid with --isolated docker"
                .to_string(),
        );
    }

    // User isolation validation
    if options.user {
        // User isolation is not supported with Docker
        if options.isolated.as_deref() == Some("docker") {
            return Err(
                "--isolated-user is not supported with Docker isolation. Docker uses its own user namespace for isolation."
                    .to_string(),
            );
        }
        // Validate custom username if provided
        if let Some(ref username) = options.user_name {
            let username_regex = regex::Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap();
            if !username_regex.is_match(username) {
                return Err(format!(
                    "Invalid username format for --isolated-user: \"{}\". Username should contain only letters, numbers, hyphens, and underscores.",
                    username
                ));
            }
            if username.len() > 32 {
                return Err(format!(
                    "Username too long for --isolated-user: \"{}\". Maximum length is 32 characters.",
                    username
                ));
            }
        }
    }

    // Keep-user validation
    if options.keep_user && !options.user {
        return Err("--keep-user option is only valid with --isolated-user".to_string());
    }

    // Validate output format
    if let Some(ref format) = options.output_format {
        if !VALID_OUTPUT_FORMATS.contains(&format.as_str()) {
            return Err(format!(
                "Invalid output format: \"{}\". Valid options are: {}",
                format,
                VALID_OUTPUT_FORMATS.join(", ")
            ));
        }
    }

    // Single-record and list query modes are mutually exclusive
    if options.status.is_some() && options.list {
        return Err("Cannot use both --status and --list at the same time".to_string());
    }

    // Output format is only valid with query modes
    if options.output_format.is_some() && options.status.is_none() && !options.list {
        return Err("--output-format option is only valid with --status or --list".to_string());
    }

    // Validate shell option
    if !VALID_SHELLS.contains(&options.shell.as_str()) {
        return Err(format!(
            "Invalid shell: \"{}\". Valid options are: {}",
            options.shell,
            VALID_SHELLS.join(", ")
        ));
    }

    // Validate session ID is a valid UUID if provided
    if let Some(ref session_id) = options.session_id {
        if !is_valid_uuid(session_id) {
            return Err(format!(
                "Invalid session ID: \"{}\". Session ID must be a valid UUID v4.",
                session_id
            ));
        }
    }

    Ok(())
}

/// Generate a unique session name
pub fn generate_session_name(prefix: Option<&str>) -> String {
    use std::cell::RefCell;
    use std::time::{SystemTime, UNIX_EPOCH};

    thread_local! {
        static STATE: RefCell<u64> = RefCell::new(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos() as u64
        );
    }

    fn next_random() -> u64 {
        STATE.with(|state| {
            let mut s = state.borrow_mut();
            *s ^= *s << 13;
            *s ^= *s >> 7;
            *s ^= *s << 17;
            *s
        })
    }

    let prefix = prefix.unwrap_or("start");
    let timestamp = chrono::Utc::now().timestamp_millis();
    let random: String = (0..6)
        .map(|_| {
            let idx = (next_random() % 36) as u8;
            if idx < 10 {
                (b'0' + idx) as char
            } else {
                (b'a' + idx - 10) as char
            }
        })
        .collect();
    format!("{}-{}-{}", prefix, timestamp, random)
}

/// Check if any isolation options are present
pub fn has_isolation(options: &WrapperOptions) -> bool {
    options.isolated.is_some()
}

/// Get the effective mode for isolation
/// Multiplexers default to attached, docker defaults to attached
pub fn get_effective_mode(options: &WrapperOptions) -> &'static str {
    if options.detached {
        "detached"
    } else {
        // Default to attached for all backends
        "attached"
    }
}

#[cfg(test)]
#[path = "args_parser_tests.rs"]
mod tests;
