//! User Manager for start-command
//!
//! Provides utilities for creating isolated users with the same
//! group memberships as the current user. This enables true user
//! isolation while preserving access to sudo, docker, and other
//! privileged groups.

use std::env;
use std::process::Command;

/// Result of a user operation
#[derive(Debug, Default)]
pub struct UserOperationResult {
    /// Whether the operation succeeded
    pub success: bool,
    /// Message describing the result
    pub message: String,
    /// Username (for create operations)
    pub username: Option<String>,
    /// Groups assigned (for create operations)
    pub groups: Option<Vec<String>>,
    /// Whether the user already existed
    pub already_exists: bool,
}

/// User information
#[derive(Debug, Default)]
pub struct UserInfo {
    /// Whether the user exists
    pub exists: bool,
    /// User ID
    pub uid: Option<u32>,
    /// Group ID
    pub gid: Option<u32>,
    /// Groups the user belongs to
    pub groups: Option<Vec<String>>,
    /// Home directory
    pub home: Option<String>,
    /// Shell
    pub shell: Option<String>,
}

/// Get the current user's username
pub fn get_current_user() -> String {
    // Try whoami command
    if let Ok(output) = Command::new("whoami").output() {
        if output.status.success() {
            return String::from_utf8_lossy(&output.stdout).trim().to_string();
        }
    }

    // Fallback to environment variables
    env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Get the groups the current user belongs to
pub fn get_current_user_groups() -> Vec<String> {
    if let Ok(output) = Command::new("groups").output() {
        if output.status.success() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            // Output format: "user : group1 group2 group3" or "group1 group2 group3"
            let parts: Vec<&str> = output_str.split(':').collect();
            let groups_part = if parts.len() > 1 { parts[1] } else { parts[0] };
            return groups_part
                .split_whitespace()
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
        }
    }

    if is_debug() {
        eprintln!("[DEBUG] Failed to get user groups");
    }
    Vec::new()
}

/// Check if a user exists on the system
pub fn user_exists(username: &str) -> bool {
    Command::new("id")
        .arg(username)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Check if a group exists on the system
pub fn group_exists(groupname: &str) -> bool {
    // Try getent first (Linux)
    if let Ok(status) = Command::new("getent")
        .args(["group", groupname])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        if status.success() {
            return true;
        }
    }

    // Fallback to dscl for macOS
    if let Ok(status) = Command::new("dscl")
        .args([".", "-read", &format!("/Groups/{}", groupname)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        if status.success() {
            return true;
        }
    }

    false
}

/// Generate a unique username for isolation
pub fn generate_isolated_username(prefix: Option<&str>) -> String {
    let prefix = prefix.unwrap_or("start");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let timestamp_base36 = format!("{:x}", timestamp);
    let random: String = (0..4)
        .map(|_| {
            let idx = simple_random() % 36;
            if idx < 10 {
                (b'0' + idx as u8) as char
            } else {
                (b'a' + (idx - 10) as u8) as char
            }
        })
        .collect();
    // Keep username short (max 31 chars)
    format!("{}-{}{}", prefix, timestamp_base36, random)
        .chars()
        .take(31)
        .collect()
}

/// Simple random number generator
fn simple_random() -> usize {
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

    STATE.with(|state| {
        let mut s = state.borrow_mut();
        *s ^= *s << 13;
        *s ^= *s >> 7;
        *s ^= *s << 17;
        (*s % 1000) as usize
    })
}

/// Options for creating a user
#[derive(Debug, Default)]
pub struct CreateUserOptions {
    /// If true, create user with nologin shell
    pub no_login: bool,
    /// Home directory (default: /home/username)
    pub home_dir: Option<String>,
}

/// Create a new user with specified groups
/// Requires sudo access
pub fn create_user(
    username: &str,
    groups: &[String],
    options: &CreateUserOptions,
) -> UserOperationResult {
    if cfg!(windows) {
        return UserOperationResult {
            success: false,
            message: "User creation is not supported on Windows".to_string(),
            username: Some(username.to_string()),
            ..Default::default()
        };
    }

    if user_exists(username) {
        return UserOperationResult {
            success: true,
            message: format!("User \"{}\" already exists", username),
            username: Some(username.to_string()),
            already_exists: true,
            ..Default::default()
        };
    }

    // Build useradd command
    let mut cmd = Command::new("sudo");
    cmd.arg("-n").arg("useradd");

    // Add home directory option
    if let Some(ref home) = options.home_dir {
        cmd.arg("-d").arg(home);
    }
    cmd.arg("-m"); // Create home directory

    // Add shell option
    if options.no_login {
        cmd.arg("-s").arg("/usr/sbin/nologin");
    } else {
        cmd.arg("-s").arg("/bin/bash");
    }

    // Filter groups to only existing ones
    let existing_groups: Vec<&String> = groups.iter().filter(|g| group_exists(g)).collect();

    if !existing_groups.is_empty() {
        let groups_str: Vec<&str> = existing_groups.iter().map(|s| s.as_str()).collect();
        cmd.arg("-G").arg(groups_str.join(","));
    }

    // Add username
    cmd.arg(username);

    if is_debug() {
        eprintln!("[DEBUG] Creating user: {:?}", cmd);
        eprintln!(
            "[DEBUG] Groups to add: {}",
            existing_groups
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    match cmd.output() {
        Ok(output) => {
            if output.status.success() {
                UserOperationResult {
                    success: true,
                    message: format!(
                        "Created user \"{}\" with groups: {}",
                        username,
                        if existing_groups.is_empty() {
                            "none".to_string()
                        } else {
                            existing_groups
                                .iter()
                                .map(|s| s.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        }
                    ),
                    username: Some(username.to_string()),
                    groups: Some(existing_groups.into_iter().cloned().collect()),
                    ..Default::default()
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                UserOperationResult {
                    success: false,
                    message: format!(
                        "Failed to create user: {}",
                        if stderr.trim().is_empty() {
                            "Unknown error"
                        } else {
                            stderr.trim()
                        }
                    ),
                    username: Some(username.to_string()),
                    ..Default::default()
                }
            }
        }
        Err(e) => UserOperationResult {
            success: false,
            message: format!("Failed to create user: {}", e),
            username: Some(username.to_string()),
            ..Default::default()
        },
    }
}

/// Options for creating an isolated user
#[derive(Debug, Default)]
pub struct CreateIsolatedUserOptions {
    /// Only include these groups
    pub include_groups: Option<Vec<String>>,
    /// Exclude these groups
    pub exclude_groups: Option<Vec<String>>,
    /// Create with nologin shell
    pub no_login: bool,
}

/// Create an isolated user with the same groups as the current user
pub fn create_isolated_user(
    custom_username: Option<&str>,
    options: &CreateIsolatedUserOptions,
) -> UserOperationResult {
    let username = custom_username
        .map(String::from)
        .unwrap_or_else(|| generate_isolated_username(None));

    let mut groups = get_current_user_groups();

    // Filter groups if specified
    if let Some(ref include) = options.include_groups {
        groups.retain(|g| include.contains(g));
    }

    if let Some(ref exclude) = options.exclude_groups {
        groups.retain(|g| !exclude.contains(g));
    }

    // Important groups for isolation to work properly
    let important_groups = ["sudo", "docker", "wheel", "admin"];
    let current_groups = get_current_user_groups();
    let inherited_important: Vec<&str> = important_groups
        .iter()
        .copied()
        .filter(|g| current_groups.iter().any(|cg| cg == *g))
        .collect();

    if is_debug() {
        eprintln!("[DEBUG] Current user groups: {}", current_groups.join(", "));
        eprintln!("[DEBUG] Groups to inherit: {}", groups.join(", "));
        eprintln!(
            "[DEBUG] Important groups found: {}",
            inherited_important.join(", ")
        );
    }

    create_user(
        &username,
        &groups,
        &CreateUserOptions {
            no_login: options.no_login,
            ..Default::default()
        },
    )
}

/// Options for deleting a user
#[derive(Debug, Default)]
pub struct DeleteUserOptions {
    /// Remove home directory
    pub remove_home: bool,
}

/// Delete a user and optionally their home directory
/// Requires sudo access
pub fn delete_user(username: &str, options: &DeleteUserOptions) -> UserOperationResult {
    if cfg!(windows) {
        return UserOperationResult {
            success: false,
            message: "User deletion is not supported on Windows".to_string(),
            ..Default::default()
        };
    }

    if !user_exists(username) {
        return UserOperationResult {
            success: true,
            message: format!("User \"{}\" does not exist", username),
            ..Default::default()
        };
    }

    let mut cmd = Command::new("sudo");
    cmd.arg("-n").arg("userdel");

    if options.remove_home {
        cmd.arg("-r"); // Remove home directory
    }

    cmd.arg(username);

    if is_debug() {
        eprintln!("[DEBUG] Deleting user: {:?}", cmd);
    }

    match cmd.output() {
        Ok(output) => {
            if output.status.success() {
                UserOperationResult {
                    success: true,
                    message: format!("Deleted user \"{}\"", username),
                    ..Default::default()
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                UserOperationResult {
                    success: false,
                    message: format!(
                        "Failed to delete user: {}",
                        if stderr.trim().is_empty() {
                            "Unknown error"
                        } else {
                            stderr.trim()
                        }
                    ),
                    ..Default::default()
                }
            }
        }
        Err(e) => UserOperationResult {
            success: false,
            message: format!("Failed to delete user: {}", e),
            ..Default::default()
        },
    }
}

/// Get information about a user
pub fn get_user_info(username: &str) -> UserInfo {
    if !user_exists(username) {
        return UserInfo {
            exists: false,
            ..Default::default()
        };
    }

    let mut info = UserInfo {
        exists: true,
        ..Default::default()
    };

    // Get uid and gid from id command
    if let Ok(output) = Command::new("id").arg(username).output() {
        if output.status.success() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            // Parse: uid=1000(user) gid=1000(group) groups=...
            if let Some(uid_match) = output_str
                .split_whitespace()
                .next()
                .and_then(|s| s.strip_prefix("uid="))
            {
                if let Some(uid_str) = uid_match.split('(').next() {
                    info.uid = uid_str.parse().ok();
                }
            }
            if let Some(gid_part) = output_str.split_whitespace().nth(1) {
                if let Some(gid_match) = gid_part.strip_prefix("gid=") {
                    if let Some(gid_str) = gid_match.split('(').next() {
                        info.gid = gid_str.parse().ok();
                    }
                }
            }
        }
    }

    // Get groups
    if let Ok(output) = Command::new("groups").arg(username).output() {
        if output.status.success() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let groups_part = output_str.split(':').next_back().unwrap_or(&output_str);
            info.groups = Some(
                groups_part
                    .split_whitespace()
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
            );
        }
    }

    // Get home and shell from getent passwd
    if let Ok(output) = Command::new("getent").args(["passwd", username]).output() {
        if output.status.success() {
            let output_str = String::from_utf8_lossy(&output.stdout);
            let parts: Vec<&str> = output_str.trim().split(':').collect();
            if parts.len() >= 7 {
                info.home = Some(parts[5].to_string());
                info.shell = Some(parts[6].to_string());
            }
        }
    }

    info
}

/// Check if the current process has sudo access without password
pub fn has_sudo_access() -> bool {
    Command::new("sudo")
        .args(["-n", "true"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn is_debug() -> bool {
    env::var("START_DEBUG").is_ok_and(|v| v == "1" || v == "true")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_current_user() {
        let user = get_current_user();
        assert!(!user.is_empty());
        assert_ne!(user, "unknown");
    }

    #[test]
    fn test_get_current_user_groups() {
        // The groups command is Unix-specific, skip on Windows
        if cfg!(windows) {
            return;
        }
        let groups = get_current_user_groups();
        // Should have at least one group (the user's primary group)
        assert!(!groups.is_empty());
    }

    #[test]
    fn test_generate_isolated_username() {
        let name1 = generate_isolated_username(None);
        let name2 = generate_isolated_username(None);
        assert!(name1.starts_with("start-"));
        assert!(name1.len() <= 31);
        // Names should be different (with high probability)
        assert_ne!(name1, name2);
    }

    #[test]
    fn test_generate_isolated_username_with_prefix() {
        let name = generate_isolated_username(Some("test"));
        assert!(name.starts_with("test-"));
    }

    #[test]
    fn test_user_exists_root() {
        // Root should exist on Unix systems
        if !cfg!(windows) {
            assert!(user_exists("root"));
        }
    }

    #[test]
    fn test_user_not_exists() {
        assert!(!user_exists("this_user_definitely_does_not_exist_12345"));
    }

    #[test]
    fn test_group_exists() {
        // On most Unix systems, at least one of these groups should exist
        if !cfg!(windows) {
            // Linux typically has root/sudo, macOS has wheel/admin/staff
            let found_group = group_exists("root")
                || group_exists("wheel")
                || group_exists("sudo")
                || group_exists("admin")
                || group_exists("staff");
            assert!(
                found_group,
                "Expected at least one common group (root/wheel/sudo/admin/staff) to exist"
            );
        }
    }
}
