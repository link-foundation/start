//! Execution Store - Dual storage (.lino text + .links binary) for command execution records

use chrono::Utc;
use lino_objects_codec::{decode, encode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

/// Default application folder name
const DEFAULT_APP_FOLDER_NAME: &str = ".start-command";
/// Lino database file name
const LINO_DB_FILE: &str = "executions.lino";
/// Links database file name
const LINKS_DB_FILE: &str = "executions.links";
/// Lock file name
const LOCK_FILE: &str = "executions.lock";
/// Lock timeout in milliseconds
const LOCK_TIMEOUT_MS: u64 = 30000;
/// Consider lock stale after this many milliseconds
const LOCK_STALE_MS: u64 = 60000;

/// Execution status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Executing,
    Executed,
}

impl ExecutionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ExecutionStatus::Executing => "executing",
            ExecutionStatus::Executed => "executed",
        }
    }
}

impl std::fmt::Display for ExecutionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Command Execution Record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRecord {
    pub uuid: String,
    pub pid: Option<u32>,
    pub status: ExecutionStatus,
    pub exit_code: Option<i32>,
    pub command: String,
    pub log_path: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub working_directory: String,
    pub shell: String,
    pub platform: String,
    #[serde(default)]
    pub options: HashMap<String, Value>,
}

impl ExecutionRecord {
    /// Create a new execution record
    pub fn new(command: &str) -> Self {
        let now = Utc::now();
        ExecutionRecord {
            uuid: Uuid::new_v4().to_string(),
            pid: None,
            status: ExecutionStatus::Executing,
            exit_code: None,
            command: command.to_string(),
            log_path: String::new(),
            start_time: now.to_rfc3339(),
            end_time: None,
            working_directory: env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            shell: env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
            platform: std::env::consts::OS.to_string(),
            options: HashMap::new(),
        }
    }

    /// Create a new execution record with options
    pub fn with_options(options: ExecutionRecordOptions) -> Self {
        let mut record = Self::new(&options.command);
        if let Some(uuid) = options.uuid {
            record.uuid = uuid;
        }
        if let Some(pid) = options.pid {
            record.pid = Some(pid);
        }
        if let Some(status) = options.status {
            record.status = status;
        }
        if let Some(exit_code) = options.exit_code {
            record.exit_code = Some(exit_code);
        }
        if let Some(log_path) = options.log_path {
            record.log_path = log_path;
        }
        if let Some(start_time) = options.start_time {
            record.start_time = start_time;
        }
        if let Some(end_time) = options.end_time {
            record.end_time = Some(end_time);
        }
        if let Some(working_directory) = options.working_directory {
            record.working_directory = working_directory;
        }
        if let Some(shell) = options.shell {
            record.shell = shell;
        }
        if let Some(platform) = options.platform {
            record.platform = platform;
        }
        if let Some(opts) = options.options {
            record.options = opts;
        }
        record
    }

    /// Mark execution as completed
    pub fn complete(&mut self, exit_code: i32) {
        self.status = ExecutionStatus::Executed;
        self.exit_code = Some(exit_code);
        self.end_time = Some(Utc::now().to_rfc3339());
    }

    /// Convert to JSON Value
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// Create from JSON Value
    pub fn from_json(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }
}

/// Options for creating an execution record
#[derive(Debug, Default)]
pub struct ExecutionRecordOptions {
    pub uuid: Option<String>,
    pub command: String,
    pub pid: Option<u32>,
    pub status: Option<ExecutionStatus>,
    pub exit_code: Option<i32>,
    pub log_path: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub working_directory: Option<String>,
    pub shell: Option<String>,
    pub platform: Option<String>,
    pub options: Option<HashMap<String, Value>>,
}

/// File-based lock manager
pub struct LockManager {
    lock_file_path: PathBuf,
    lock_acquired: bool,
}

impl LockManager {
    /// Create a new lock manager
    pub fn new(lock_file_path: PathBuf) -> Self {
        LockManager {
            lock_file_path,
            lock_acquired: false,
        }
    }

    /// Acquire an exclusive lock
    pub fn acquire(&mut self, timeout_ms: u64) -> bool {
        let start = std::time::Instant::now();
        let timeout = Duration::from_millis(timeout_ms);

        while start.elapsed() < timeout {
            // Check if existing lock is stale
            if self.lock_file_path.exists() {
                if let Some(lock_data) = self.read_lock_file() {
                    if self.is_lock_stale(&lock_data) {
                        let _ = fs::remove_file(&self.lock_file_path);
                    }
                }
            }

            // Try to create lock file exclusively
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&self.lock_file_path)
            {
                Ok(mut file) => {
                    let lock_data = json!({
                        "pid": std::process::id(),
                        "timestamp": std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0),
                        "hostname": hostname::get()
                            .map(|h| h.to_string_lossy().to_string())
                            .unwrap_or_default()
                    });
                    let _ = file.write_all(lock_data.to_string().as_bytes());
                    self.lock_acquired = true;
                    return true;
                }
                Err(_) => {
                    // Lock file exists, wait and retry
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            }
        }

        false
    }

    /// Release the lock
    pub fn release(&mut self) {
        if self.lock_acquired {
            let _ = fs::remove_file(&self.lock_file_path);
            self.lock_acquired = false;
        }
    }

    /// Read lock file data
    fn read_lock_file(&self) -> Option<Value> {
        let content = fs::read_to_string(&self.lock_file_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// Check if lock is stale
    fn is_lock_stale(&self, lock_data: &Value) -> bool {
        let timestamp = lock_data.get("timestamp").and_then(|t| t.as_u64());

        // Check if lock is too old
        if let Some(ts) = timestamp {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if now - ts > LOCK_STALE_MS {
                return true;
            }
        } else {
            return true;
        }

        // Check if the process that holds the lock is still running (Unix only)
        #[cfg(unix)]
        {
            let pid = lock_data.get("pid").and_then(|p| p.as_u64());
            if let Some(p) = pid {
                // Check if process exists using kill(pid, 0)
                let result = unsafe { libc::kill(p as i32, 0) };
                if result != 0 {
                    return true; // Process doesn't exist
                }
            }
        }

        false
    }
}

impl Drop for LockManager {
    fn drop(&mut self) {
        self.release();
    }
}

/// Check if clink is installed
pub fn is_clink_installed() -> bool {
    Command::new("clink")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Get the default application folder path
pub fn get_default_app_folder() -> PathBuf {
    if let Ok(custom) = env::var("START_APP_FOLDER") {
        return PathBuf::from(custom);
    }

    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(DEFAULT_APP_FOLDER_NAME)
}

/// ExecutionStore - Main store class for managing execution records
#[derive(Clone)]
pub struct ExecutionStore {
    app_folder: PathBuf,
    lino_db_path: PathBuf,
    links_db_path: PathBuf,
    lock_file_path: PathBuf,
    use_links: bool,
    verbose: bool,
}

/// Options for creating an ExecutionStore
#[derive(Debug, Default)]
pub struct ExecutionStoreOptions {
    pub app_folder: Option<PathBuf>,
    pub use_links: Option<bool>,
    pub verbose: bool,
}

impl ExecutionStore {
    /// Create a new ExecutionStore with default options
    pub fn new() -> Self {
        Self::with_options(ExecutionStoreOptions::default())
    }

    /// Create a new ExecutionStore with options
    pub fn with_options(options: ExecutionStoreOptions) -> Self {
        let app_folder = options.app_folder.unwrap_or_else(get_default_app_folder);
        let lino_db_path = app_folder.join(LINO_DB_FILE);
        let links_db_path = app_folder.join(LINKS_DB_FILE);
        let lock_file_path = app_folder.join(LOCK_FILE);
        let use_links = options.use_links.unwrap_or_else(is_clink_installed);

        // Ensure app folder exists
        let _ = fs::create_dir_all(&app_folder);

        ExecutionStore {
            app_folder,
            lino_db_path,
            links_db_path,
            lock_file_path,
            use_links,
            verbose: options.verbose,
        }
    }

    /// Log verbose message
    fn log(&self, message: &str) {
        if self.verbose {
            println!("[ExecutionStore] {}", message);
        }
    }

    /// Read all execution records from lino file
    pub fn read_lino_records(&self) -> Vec<ExecutionRecord> {
        if !self.lino_db_path.exists() {
            return Vec::new();
        }

        match fs::read_to_string(&self.lino_db_path) {
            Ok(content) => {
                if content.trim().is_empty() {
                    return Vec::new();
                }

                match decode(&content) {
                    Ok(data) => {
                        if let Value::Array(arr) = data {
                            arr.iter().filter_map(ExecutionRecord::from_json).collect()
                        } else {
                            Vec::new()
                        }
                    }
                    Err(e) => {
                        self.log(&format!("Error decoding lino records: {}", e));
                        Vec::new()
                    }
                }
            }
            Err(e) => {
                self.log(&format!("Error reading lino records: {}", e));
                Vec::new()
            }
        }
    }

    /// Write execution records to lino file
    fn write_lino_records(&self, records: &[ExecutionRecord]) -> std::io::Result<()> {
        let data: Vec<Value> = records.iter().map(|r| r.to_json()).collect();
        let content = encode(&Value::Array(data));
        fs::write(&self.lino_db_path, content)?;
        self.log(&format!("Wrote {} records to lino file", records.len()));
        Ok(())
    }

    /// Build clink query for creating/updating a record
    fn build_clink_create_query(&self, record: &ExecutionRecord) -> String {
        let obj = record.to_json();
        let mut links = Vec::new();

        // Create main record link
        links.push(format!(
            "({}: ExecutionRecord {})",
            record.uuid, record.uuid
        ));

        // Create property links
        if let Value::Object(map) = obj {
            for (key, value) in map {
                let escaped_value = match value {
                    Value::Object(_) | Value::Array(_) => {
                        serde_json::to_string(&value).unwrap_or_default()
                    }
                    Value::String(s) => s,
                    Value::Null => "null".to_string(),
                    other => other.to_string(),
                };
                links.push(format!(
                    "({}.{}: {} \"{}\")",
                    record.uuid,
                    key,
                    key,
                    escaped_value.replace('"', "\\\"")
                ));
            }
        }

        format!("() (({})))", links.join(") ("))
    }

    /// Execute clink command
    fn exec_clink(&self, query: &str) -> Result<String, String> {
        match Command::new("clink")
            .arg(query)
            .arg("--db")
            .arg(&self.links_db_path)
            .output()
        {
            Ok(output) => {
                if output.status.success() {
                    Ok(String::from_utf8_lossy(&output.stdout).to_string())
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                    self.log(&format!("Clink error: {}", stderr));
                    Err(stderr)
                }
            }
            Err(e) => {
                self.log(&format!("Clink execution error: {}", e));
                Err(e.to_string())
            }
        }
    }

    /// Write a record to the links database using clink
    fn write_links_record(&self, record: &ExecutionRecord) -> bool {
        if !self.use_links {
            return false;
        }

        let query = self.build_clink_create_query(record);
        match self.exec_clink(&query) {
            Ok(_) => {
                self.log(&format!("Wrote record {} to links database", record.uuid));
                true
            }
            Err(_) => false,
        }
    }

    /// Delete a record from links database
    fn delete_links_record(&self, uuid: &str) -> bool {
        if !self.use_links {
            return false;
        }

        let query = format!("(($id: {} $any)) ()", uuid);
        self.exec_clink(&query).is_ok()
    }

    /// Save an execution record (creates or updates)
    pub fn save(&self, record: &ExecutionRecord) -> Result<(), String> {
        let mut lock = LockManager::new(self.lock_file_path.clone());

        if !lock.acquire(LOCK_TIMEOUT_MS) {
            return Err("Failed to acquire lock for database write".to_string());
        }

        // Read existing records
        let mut records = self.read_lino_records();

        // Find existing record index
        let existing_index = records.iter().position(|r| r.uuid == record.uuid);

        if let Some(idx) = existing_index {
            // Update existing record
            records[idx] = record.clone();
        } else {
            // Add new record
            records.push(record.clone());
        }

        // Write to lino file
        self.write_lino_records(&records)
            .map_err(|e| e.to_string())?;

        // Also write to links database if available
        if self.use_links {
            self.write_links_record(record);
        }

        Ok(())
    }

    /// Get an execution record by UUID
    pub fn get(&self, uuid: &str) -> Option<ExecutionRecord> {
        self.read_lino_records()
            .into_iter()
            .find(|r| r.uuid == uuid)
    }

    /// Get all execution records
    pub fn get_all(&self) -> Vec<ExecutionRecord> {
        self.read_lino_records()
    }

    /// Get records filtered by status
    pub fn get_by_status(&self, status: ExecutionStatus) -> Vec<ExecutionRecord> {
        self.read_lino_records()
            .into_iter()
            .filter(|r| r.status == status)
            .collect()
    }

    /// Get currently executing commands
    pub fn get_executing(&self) -> Vec<ExecutionRecord> {
        self.get_by_status(ExecutionStatus::Executing)
    }

    /// Get recently executed commands
    pub fn get_recent(&self, limit: usize) -> Vec<ExecutionRecord> {
        let mut records = self.read_lino_records();
        // Sort by start_time descending
        records.sort_by(|a, b| b.start_time.cmp(&a.start_time));
        records.truncate(limit);
        records
    }

    /// Clean up stale "executing" records (processes no longer running or aged out)
    pub fn cleanup_stale(&self, options: CleanupOptions) -> CleanupResult {
        let max_age_ms = options.max_age_ms.unwrap_or(24 * 60 * 60 * 1000);
        let dry_run = options.dry_run;
        let mut result = CleanupResult {
            cleaned: 0,
            records: Vec::new(),
            errors: Vec::new(),
        };

        let records = self.read_lino_records();
        let mut stale_records: Vec<ExecutionRecord> = Vec::new();

        for record in records
            .iter()
            .filter(|r| r.status == ExecutionStatus::Executing)
        {
            let mut is_stale = false;

            // Check if process is still running (Unix only, same platform)
            #[cfg(unix)]
            if let Some(pid) = record.pid {
                if record.platform == std::env::consts::OS
                    && unsafe { libc::kill(pid as i32, 0) } != 0
                {
                    is_stale = true;
                    self.log(&format!("Stale: {} (PID {} gone)", record.uuid, pid));
                }
            }

            // Check age
            if !is_stale {
                if let Ok(st) = chrono::DateTime::parse_from_rfc3339(&record.start_time) {
                    let age_ms =
                        (chrono::Utc::now() - st.with_timezone(&chrono::Utc)).num_milliseconds();
                    if age_ms > max_age_ms as i64 {
                        is_stale = true;
                        self.log(&format!(
                            "Stale: {} ({}min old)",
                            record.uuid,
                            age_ms / 60000
                        ));
                    }
                }
            }

            if is_stale {
                stale_records.push(record.clone());
            }
        }

        result.records = stale_records.clone();

        if !dry_run && !stale_records.is_empty() {
            let mut lock = LockManager::new(self.lock_file_path.clone());
            if !lock.acquire(LOCK_TIMEOUT_MS) {
                result.errors.push("Failed to acquire lock".to_string());
                return result;
            }

            let mut current = self.read_lino_records();
            for stale in &stale_records {
                if let Some(i) = current.iter().position(|r| r.uuid == stale.uuid) {
                    current[i].status = ExecutionStatus::Executed;
                    current[i].exit_code = Some(-1);
                    current[i].end_time = Some(chrono::Utc::now().to_rfc3339());
                    result.cleaned += 1;
                }
            }

            if let Err(e) = self.write_lino_records(&current) {
                result.errors.push(format!("Cleanup error: {}", e));
            } else {
                self.log(&format!("Cleaned {} stale records", result.cleaned));
            }
        } else if dry_run {
            result.cleaned = stale_records.len();
        }

        result
    }

    /// Delete an execution record
    pub fn delete(&self, uuid: &str) -> Result<bool, String> {
        let mut lock = LockManager::new(self.lock_file_path.clone());

        if !lock.acquire(LOCK_TIMEOUT_MS) {
            return Err("Failed to acquire lock for database write".to_string());
        }

        let records = self.read_lino_records();
        let filtered: Vec<_> = records.iter().filter(|r| r.uuid != uuid).cloned().collect();

        if filtered.len() == records.len() {
            return Ok(false); // Record not found
        }

        self.write_lino_records(&filtered)
            .map_err(|e| e.to_string())?;

        // Also delete from links database
        if self.use_links {
            self.delete_links_record(uuid);
        }

        Ok(true)
    }

    /// Delete all records
    pub fn clear(&self) -> Result<(), String> {
        let mut lock = LockManager::new(self.lock_file_path.clone());

        if !lock.acquire(LOCK_TIMEOUT_MS) {
            return Err("Failed to acquire lock for database write".to_string());
        }

        self.write_lino_records(&[]).map_err(|e| e.to_string())?;

        // Clear links database by removing the file
        if self.use_links && self.links_db_path.exists() {
            let _ = fs::remove_file(&self.links_db_path);
        }

        Ok(())
    }

    /// Verify that both databases have consistent data
    pub fn verify_consistency(&self) -> ConsistencyResult {
        let mut result = ConsistencyResult {
            consistent: true,
            lino_count: 0,
            links_count: 0,
            errors: Vec::new(),
        };

        // Read lino records
        let lino_records = self.read_lino_records();
        result.lino_count = lino_records.len();

        if !self.use_links {
            result
                .errors
                .push("clink not installed - links database not available".to_string());
            return result;
        }

        // Query links database for all ExecutionRecord links
        match self.exec_clink("((($id: ExecutionRecord $uuid)) (($id: ExecutionRecord $uuid)))") {
            Ok(output) => {
                // Count unique UUIDs in the output
                let re = regex::Regex::new(r"ExecutionRecord\s+([a-f0-9-]{36})").unwrap();
                let uuids: std::collections::HashSet<_> = re
                    .captures_iter(&output)
                    .filter_map(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
                    .collect();
                result.links_count = uuids.len();

                // Check if counts match
                if result.lino_count != result.links_count {
                    result.consistent = false;
                    result.errors.push(format!(
                        "Record count mismatch: lino={}, links={}",
                        result.lino_count, result.links_count
                    ));
                }

                // Verify each lino record exists in links
                for record in &lino_records {
                    if !uuids.contains(&record.uuid.to_lowercase()) {
                        result.consistent = false;
                        result.errors.push(format!(
                            "Record {} missing from links database",
                            record.uuid
                        ));
                    }
                }
            }
            Err(e) => {
                result
                    .errors
                    .push(format!("Failed to query links database: {}", e));
                result.consistent = false;
            }
        }

        result
    }

    /// Get database statistics
    pub fn get_stats(&self) -> ExecutionStats {
        let records = self.read_lino_records();
        let executing = records
            .iter()
            .filter(|r| r.status == ExecutionStatus::Executing)
            .count();
        let executed = records
            .iter()
            .filter(|r| r.status == ExecutionStatus::Executed)
            .count();
        let successful = records
            .iter()
            .filter(|r| r.status == ExecutionStatus::Executed && r.exit_code == Some(0))
            .count();
        let failed = records
            .iter()
            .filter(|r| {
                r.status == ExecutionStatus::Executed
                    && r.exit_code.map(|c| c != 0).unwrap_or(false)
            })
            .count();

        ExecutionStats {
            total: records.len(),
            executing,
            executed,
            successful,
            failed,
            clink_available: self.use_links,
            lino_db_path: self.lino_db_path.to_string_lossy().to_string(),
            links_db_path: self.links_db_path.to_string_lossy().to_string(),
        }
    }

    /// Get the app folder path
    pub fn app_folder(&self) -> &Path {
        &self.app_folder
    }
}

impl Default for ExecutionStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of consistency verification
#[derive(Debug)]
pub struct ConsistencyResult {
    pub consistent: bool,
    pub lino_count: usize,
    pub links_count: usize,
    pub errors: Vec<String>,
}

/// Options for cleanup_stale: max_age_ms (default 24h), dry_run
#[derive(Debug, Default)]
pub struct CleanupOptions {
    pub max_age_ms: Option<u64>,
    pub dry_run: bool,
}

/// Result of cleanup_stale: cleaned count, records, errors
#[derive(Debug)]
pub struct CleanupResult {
    pub cleaned: usize,
    pub records: Vec<ExecutionRecord>,
    pub errors: Vec<String>,
}

/// Execution statistics
#[derive(Debug)]
pub struct ExecutionStats {
    pub total: usize,
    pub executing: usize,
    pub executed: usize,
    pub successful: usize,
    pub failed: usize,
    pub clink_available: bool,
    pub lino_db_path: String,
    pub links_db_path: String,
}

// Stub for hostname crate functionality
mod hostname {
    use std::ffi::OsString;

    pub fn get() -> Result<OsString, std::io::Error> {
        #[cfg(unix)]
        {
            let mut buf = [0u8; 256];
            let result = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut i8, buf.len()) };
            if result == 0 {
                let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                Ok(OsString::from(
                    String::from_utf8_lossy(&buf[..len]).to_string(),
                ))
            } else {
                Ok(OsString::from("unknown"))
            }
        }
        #[cfg(not(unix))]
        {
            Ok(OsString::from("unknown"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_store() -> (ExecutionStore, TempDir) {
        let temp_dir = TempDir::new().unwrap();
        let store = ExecutionStore::with_options(ExecutionStoreOptions {
            app_folder: Some(temp_dir.path().to_path_buf()),
            use_links: Some(false), // Disable links for unit tests
            verbose: false,
        });
        (store, temp_dir)
    }

    #[test]
    fn test_execution_record_new() {
        let record = ExecutionRecord::new("echo hello");
        assert!(!record.uuid.is_empty());
        assert_eq!(record.command, "echo hello");
        assert_eq!(record.status, ExecutionStatus::Executing);
        assert!(record.exit_code.is_none());
        assert!(record.end_time.is_none());
    }

    #[test]
    fn test_execution_record_complete() {
        let mut record = ExecutionRecord::new("echo hello");
        assert_eq!(record.status, ExecutionStatus::Executing);
        assert!(record.exit_code.is_none());

        record.complete(0);

        assert_eq!(record.status, ExecutionStatus::Executed);
        assert_eq!(record.exit_code, Some(0));
        assert!(record.end_time.is_some());
    }

    #[test]
    fn test_execution_record_json_roundtrip() {
        let mut record = ExecutionRecord::new("echo hello");
        record.pid = Some(12345);
        record.log_path = "/tmp/test.log".to_string();

        let json = record.to_json();
        let restored = ExecutionRecord::from_json(&json).unwrap();

        assert_eq!(restored.uuid, record.uuid);
        assert_eq!(restored.command, "echo hello");
        assert_eq!(restored.pid, Some(12345));
    }

    #[test]
    fn test_store_save_and_get() {
        let (store, _temp) = create_test_store();
        let mut record = ExecutionRecord::new("echo hello");
        record.pid = Some(12345);
        store.save(&record).unwrap();
        let retrieved = store.get(&record.uuid).unwrap();
        assert_eq!(
            (retrieved.uuid, retrieved.command.as_str(), retrieved.pid),
            (record.uuid, "echo hello", Some(12345))
        );
    }

    #[test]
    fn test_store_update() {
        let (store, _temp) = create_test_store();
        let mut record = ExecutionRecord::new("echo hello");
        store.save(&record).unwrap();
        record.complete(0);
        store.save(&record).unwrap();
        let r = store.get(&record.uuid).unwrap();
        assert_eq!(
            (r.status, r.exit_code),
            (ExecutionStatus::Executed, Some(0))
        );
    }

    #[test]
    fn test_store_get_all() {
        let (store, _temp) = create_test_store();
        for i in 1..=3 {
            store
                .save(&ExecutionRecord::new(&format!("e{}", i)))
                .unwrap();
        }
        assert_eq!(store.get_all().len(), 3);
    }

    #[test]
    fn test_store_get_by_status() {
        let (store, _temp) = create_test_store();
        store.save(&ExecutionRecord::new("1")).unwrap();
        store.save(&ExecutionRecord::new("2")).unwrap();
        let mut done = ExecutionRecord::new("3");
        done.complete(0);
        store.save(&done).unwrap();
        assert_eq!(
            (
                store.get_executing().len(),
                store.get_by_status(ExecutionStatus::Executed).len()
            ),
            (2, 1)
        );
    }

    #[test]
    fn test_store_delete() {
        let (store, _temp) = create_test_store();
        let record = ExecutionRecord::new("echo hello");
        store.save(&record).unwrap();
        assert!(store.get(&record.uuid).is_some() && store.delete(&record.uuid).unwrap());
        assert!(store.get(&record.uuid).is_none());
    }

    #[test]
    fn test_store_clear() {
        let (store, _temp) = create_test_store();
        store.save(&ExecutionRecord::new("1")).unwrap();
        store.save(&ExecutionRecord::new("2")).unwrap();
        assert_eq!(store.get_all().len(), 2);
        store.clear().unwrap();
        assert_eq!(store.get_all().len(), 0);
    }

    #[test]
    fn test_store_get_stats() {
        let (store, _temp) = create_test_store();
        store.save(&ExecutionRecord::new("1")).unwrap();
        let mut ok = ExecutionRecord::new("2");
        ok.complete(0);
        store.save(&ok).unwrap();
        let mut fail = ExecutionRecord::new("3");
        fail.complete(1);
        store.save(&fail).unwrap();
        let s = store.get_stats();
        assert_eq!(
            (s.total, s.executing, s.executed, s.successful, s.failed),
            (3, 1, 2, 1, 1)
        );
    }
    // Note: Additional tests in tests/cleanup_test.rs
}
