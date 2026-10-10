//! Failure handler for start-command
//!
//! Handles command failures - detects repository, uploads logs, creates issues

use std::env;
use std::fs;
use std::process::Command;

use crate::isolation::get_timestamp;
use crate::log_sanitizer::{sanitize_log_to_temp, StreamingSanitizer};

/// Configuration for the failure handler
#[derive(Debug, Default)]
pub struct Config {
    /// Disable automatic issue creation
    pub disable_auto_issue: bool,
    /// Disable log upload
    pub disable_log_upload: bool,
    /// Verbose mode
    pub verbose: bool,
}

/// Repository information
#[derive(Debug, Clone)]
pub struct RepoInfo {
    /// Repository owner
    pub owner: String,
    /// Repository name
    pub repo: String,
    /// Full URL
    pub url: String,
}

/// Handle command failure - detect repository, upload log, create issue
pub fn handle_failure(
    config: &Config,
    cmd_name: &str,
    full_command: &str,
    exit_code: i32,
    log_path: &str,
) {
    println!();

    // Check if auto-issue is disabled
    if config.disable_auto_issue {
        if config.verbose {
            println!("Auto-issue creation disabled via START_DISABLE_AUTO_ISSUE");
        }
        return;
    }

    // Try to detect repository for the command
    let repo_info = match detect_repository(cmd_name) {
        Some(info) => info,
        None => {
            println!("Repository not detected - automatic issue creation skipped");
            return;
        }
    };

    println!("Detected repository: {}", repo_info.url);

    // Check if gh CLI is available and authenticated
    if !is_gh_authenticated() {
        println!("GitHub CLI not authenticated - automatic issue creation skipped");
        println!("Run \"gh auth login\" to enable automatic issue creation");
        return;
    }

    // Try to upload log
    let mut log_url = None;
    if config.disable_log_upload {
        if config.verbose {
            println!("Log upload disabled via START_DISABLE_LOG_UPLOAD");
        }
    } else if is_gh_upload_log_available() {
        log_url = upload_log_with_options(log_path, config.verbose);
        if let Some(ref url) = log_url {
            println!("Log uploaded: {}", url);
        }
    } else {
        println!("gh-upload-log not installed - log upload skipped");
        println!("Install with: bun install -g gh-upload-log");
    }

    // Check if we can create issues in this repository
    if !can_create_issue(&repo_info.owner, &repo_info.repo) {
        println!("Cannot create issue in repository - skipping issue creation");
        return;
    }

    // Create issue
    if let Some(issue_url) = create_issue(&repo_info, full_command, exit_code, log_url.as_deref()) {
        println!("Issue created: {}", issue_url);
    }
}

/// Detect repository URL for a command (currently supports NPM global packages)
pub fn detect_repository(cmd_name: &str) -> Option<RepoInfo> {
    let is_windows = cfg!(windows);

    // Find command location
    let which_cmd = if is_windows { "where" } else { "which" };
    let cmd_path = Command::new(which_cmd)
        .arg(cmd_name)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())?;

    if cmd_path.is_empty() {
        return None;
    }

    // Handle Windows where command that returns multiple lines
    let cmd_path = if is_windows {
        cmd_path
            .lines()
            .next()
            .unwrap_or(&cmd_path)
            .trim()
            .to_string()
    } else {
        cmd_path
    };

    // Check if it's in npm global modules
    let _npm_global_path = Command::new("npm")
        .args(["root", "-g"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())?;

    // Check if the command is related to npm
    let real_path = fs::canonicalize(&cmd_path).ok()?;
    let real_path_str = real_path.to_string_lossy();

    let mut package_name = None;
    let mut is_npm_package = false;

    // Check if the real path is within node_modules
    if real_path_str.contains("node_modules") {
        is_npm_package = true;
        // Extract package name from path
        if let Some(idx) = real_path_str.find("node_modules/") {
            let after = &real_path_str[idx + 13..];
            package_name = after.split('/').next().map(String::from);
        }
    }

    // Try to read the bin script to extract package info
    if package_name.is_none() {
        if let Ok(content) = fs::read_to_string(&cmd_path) {
            if content.starts_with("#!/usr/bin/env node") || content.contains("node_modules") {
                is_npm_package = true;

                // Look for package path in the script
                let re = regex::Regex::new(r#"node_modules/([^/'"]+)"#).ok()?;
                if let Some(cap) = re.captures(&content) {
                    package_name = cap.get(1).map(|m| m.as_str().to_string());
                }
            }
        }
    }

    // If we couldn't confirm this is an npm package, don't proceed
    if !is_npm_package {
        return None;
    }

    // Use command name if package name not found
    let package_name = package_name.unwrap_or_else(|| cmd_name.to_string());

    // Try to get repository URL from npm
    if let Some(npm_url) = get_npm_repository_url(&package_name) {
        if let Some(info) = parse_git_url(&npm_url) {
            return Some(info);
        }
    }

    // Try to get bugs URL as fallback
    if let Ok(output) = Command::new("npm")
        .args(["view", &package_name, "bugs.url"])
        .output()
    {
        if output.status.success() {
            let bugs_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // parse_git_url anchors on the github.com host itself, so no
            // separate (and substring-only) host check is needed here.
            if let Some(info) = parse_git_url(&bugs_url) {
                return Some(info);
            }
        }
    }

    None
}

/// Get repository URL from npm registry
fn get_npm_repository_url(package_name: &str) -> Option<String> {
    let output = Command::new("npm")
        .args(["view", package_name, "repository.url"])
        .output()
        .ok()?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !url.is_empty() {
            return Some(url);
        }
    }
    None
}

/// Parse a git URL to extract owner, repo, and normalized URL
pub fn parse_git_url(url: &str) -> Option<RepoInfo> {
    if url.is_empty() {
        return None;
    }

    let re = regex::Regex::new(r#"github\.com[/:]([^/]+)/([^/.]+)"#).ok()?;
    let caps = re.captures(url)?;

    let owner = caps.get(1)?.as_str().to_string();
    let mut repo = caps.get(2)?.as_str().to_string();
    repo = repo.trim_end_matches(".git").to_string();

    Some(RepoInfo {
        owner: owner.clone(),
        repo: repo.clone(),
        url: format!("https://github.com/{}/{}", owner, repo),
    })
}

/// Check if GitHub CLI is authenticated
pub fn is_gh_authenticated() -> bool {
    Command::new("gh")
        .args(["auth", "status"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Check if gh-upload-log is available
pub fn is_gh_upload_log_available() -> bool {
    is_command_available("gh-upload-log")
}

fn is_command_available(command: &str) -> bool {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    Command::new(which_cmd)
        .arg(command)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Install gh-upload-log with an available JavaScript package manager.
pub fn ensure_gh_upload_log_available() -> Result<(), String> {
    if is_gh_upload_log_available() {
        return Ok(());
    }

    let installers: [(&str, &[&str]); 2] = [
        ("bun", &["install", "-g", "gh-upload-log"]),
        ("npm", &["install", "-g", "gh-upload-log"]),
    ];

    for (command, args) in installers {
        if !is_command_available(command) {
            continue;
        }

        println!(
            "gh-upload-log not found; installing with: {} {}",
            command,
            args.join(" ")
        );
        let installed = Command::new(command)
            .args(args)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);

        if installed && is_gh_upload_log_available() {
            return Ok(());
        }
    }

    Err(
        "gh-upload-log is not installed and automatic installation did not make it available on PATH."
            .to_string(),
    )
}

/// Upload a log file with gh-upload-log and stream its output to the terminal.
pub fn upload_log_interactive(log_path: &str) -> Result<i32, String> {
    upload_log_interactive_with_options(log_path, false, false)
}

/// Upload privately; unsanitized source access requires an explicit opt-out.
pub fn upload_log_interactive_with_options(
    log_path: &str,
    no_sanitize: bool,
    verbose: bool,
) -> Result<i32, String> {
    let prepared = if no_sanitize {
        None
    } else {
        Some(sanitize_log_to_temp(
            std::path::Path::new(log_path),
            verbose,
        )?)
    };
    let upload_path = prepared
        .as_ref()
        .map(|copy| copy.path.as_path())
        .unwrap_or_else(|| std::path::Path::new(log_path));
    ensure_gh_upload_log_available()?;

    let status = Command::new("gh-upload-log")
        .arg(upload_path)
        .arg("--private")
        .status()
        .map_err(|_| "Failed to run gh-upload-log.".to_string())?;

    Ok(status.code().unwrap_or(1))
}

/// Upload log file using gh-upload-log
pub fn upload_log(log_path: &str) -> Option<String> {
    upload_log_with_options(log_path, false)
}

/// Automatic log publication always sanitizes; diagnostics contain counts only.
pub fn upload_log_with_options(log_path: &str, verbose: bool) -> Option<String> {
    let prepared = match sanitize_log_to_temp(std::path::Path::new(log_path), verbose) {
        Ok(copy) => copy,
        Err(_) => {
            println!("Warning: Log sanitization failed; upload blocked.");
            return None;
        }
    };
    let output = Command::new("gh-upload-log")
        .arg(&prepared.path)
        .arg("--private")
        .output()
        .ok()?;

    if !output.status.success() {
        println!("Warning: Log upload failed.");
        return None;
    }

    let result = String::from_utf8_lossy(&output.stdout);

    // Extract URL from output
    let gist_re = regex::Regex::new(r"https://gist\.github\.com/[^\s]+").ok()?;
    if let Some(m) = gist_re.find(&result) {
        return Some(m.as_str().to_string());
    }

    let repo_re = regex::Regex::new(r"https://github\.com/[^\s]+").ok()?;
    if let Some(m) = repo_re.find(&result) {
        return Some(m.as_str().to_string());
    }

    None
}

/// Check if we can create an issue in a repository
pub fn can_create_issue(owner: &str, repo: &str) -> bool {
    Command::new("gh")
        .args([
            "repo",
            "view",
            &format!("{}/{}", owner, repo),
            "--json",
            "name",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Create an issue in the repository
pub fn create_issue(
    repo_info: &RepoInfo,
    full_command: &str,
    exit_code: i32,
    log_url: Option<&str>,
) -> Option<String> {
    let mut sanitizer =
        StreamingSanitizer::new(std::env::vars_os().filter_map(|(name, value)| {
            Some((name.into_string().ok()?, value.into_string().ok()?))
        }))
        .ok()?;
    let safe_command = String::from_utf8(sanitizer.push(full_command.as_bytes(), true)).ok()?;
    let full_command = safe_command.as_str();
    let title = format!(
        "Command failed with exit code {}: {}{}",
        exit_code,
        full_command.chars().take(50).collect::<String>(),
        if full_command.len() > 50 { "..." } else { "" }
    );

    let runtime = "Rust";
    let runtime_version = env!("CARGO_PKG_VERSION");

    let mut body = String::from("## Command Execution Failure Report\n\n");
    body.push_str(&format!("**Command:** `{}`\n\n", full_command));
    body.push_str(&format!("**Exit Code:** {}\n\n", exit_code));
    body.push_str(&format!("**Timestamp:** {}\n\n", get_timestamp()));
    body.push_str("### System Information\n\n");
    body.push_str(&format!("- **Platform:** {}\n", std::env::consts::OS));
    body.push_str(&format!("- **{} Version:** {}\n", runtime, runtime_version));
    body.push_str(&format!(
        "- **Architecture:** {}\n\n",
        std::env::consts::ARCH
    ));

    if let Some(url) = log_url {
        body.push_str("### Log File\n\n");
        body.push_str(&format!("Full log available at: {}\n\n", url));
    }

    body.push_str("---\n");
    body.push_str("*This issue was automatically created by [start-command](https://github.com/link-foundation/start)*\n");

    // No shell is involved: `Command` passes each argument through verbatim, so
    // escaping quotes here would only put backslashes into the issue text and
    // flatten its newlines into the two characters "\n" (issue #168).
    let output = Command::new("gh")
        .args([
            "issue",
            "create",
            "--repo",
            &format!("{}/{}", repo_info.owner, repo_info.repo),
            "--title",
            &title,
            "--body",
            &body,
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("Warning: Issue creation failed - {}", stderr);
        return None;
    }

    let result = String::from_utf8_lossy(&output.stdout);
    let url_re = regex::Regex::new(r"https://github\.com/[^\s]+").ok()?;
    url_re.find(&result).map(|m| m.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_git_url_https() {
        let info = parse_git_url("https://github.com/owner/repo").unwrap();
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
        assert_eq!(info.url, "https://github.com/owner/repo");
    }

    #[test]
    fn test_parse_git_url_ssh() {
        let info = parse_git_url("git@github.com:owner/repo.git").unwrap();
        assert_eq!(info.owner, "owner");
        assert_eq!(info.repo, "repo");
    }

    #[test]
    fn test_parse_git_url_with_git_suffix() {
        let info = parse_git_url("https://github.com/owner/repo.git").unwrap();
        assert_eq!(info.repo, "repo");
    }

    #[test]
    fn test_parse_git_url_invalid() {
        assert!(parse_git_url("").is_none());
        assert!(parse_git_url("not a url").is_none());
    }
}
