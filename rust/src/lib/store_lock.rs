//! Cross-language file lock. Publish fully written data with an atomic hard link.
use crate::local_hostname;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct LockManager {
    path: PathBuf,
    token: Option<String>,
    monitor_owner: bool,
    /// Extra fields published in the lock file, for example who holds it.
    metadata: serde_json::Map<String, Value>,
}

impl LockManager {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            token: None,
            monitor_owner: false,
            metadata: serde_json::Map::new(),
        }
    }

    /// Publish `key` in the lock file while it is held.
    pub fn with_metadata(mut self, key: &str, value: Value) -> Self {
        self.metadata.insert(key.to_string(), value);
        self
    }

    /// The published lock file, if one is readable.
    pub fn read_lock_file(&self) -> Option<Value> {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    }

    pub fn for_cpu_monitor(mut self) -> Self {
        self.monitor_owner = true;
        self
    }

    pub fn acquire(&mut self, timeout: u64) -> bool {
        let started = Instant::now();
        let debug = |message: &str| {
            if std::env::var("START_DEBUG").as_deref() == Ok("1") {
                eprintln!("[DEBUG] Store lock {}: {}", self.path.display(), message);
            }
        };
        while started.elapsed() < Duration::from_millis(timeout) {
            if let Ok(stat) = fs::metadata(&self.path) {
                let data = fs::read_to_string(&self.path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok());
                if self.stale(data.as_ref(), &stat) {
                    if let Ok(current) = fs::metadata(&self.path) {
                        if Self::same_file(&stat, &current) {
                            debug("reclaiming stale or malformed lock");
                            let _ = fs::remove_file(&self.path);
                        }
                    }
                }
            }
            let token = Uuid::new_v4().to_string();
            let temp = self
                .path
                .with_extension(format!("lock.{}.{}", std::process::id(), token));
            let result = (|| -> std::io::Result<()> {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)?;
                let owner = json!({"pid": std::process::id(), "timestamp":
                    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
                    "hostname": local_hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default(),
                    "token": token, "processStart": Self::process_info(std::process::id() as u64).map(|p| p.1)});
                // Metadata goes first so it can never replace the owner fields.
                let mut data = self.metadata.clone();
                if let Value::Object(owner) = owner {
                    data.extend(owner);
                }
                file.write_all(Value::Object(data).to_string().as_bytes())?;
                file.sync_all()?;
                fs::hard_link(&temp, &self.path)
            })();
            let _ = fs::remove_file(&temp);
            match result {
                Ok(()) => {
                    debug(&format!(
                        "acquired after {}ms",
                        started.elapsed().as_millis()
                    ));
                    self.token = Some(token);
                    return true;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(error) => {
                    debug(&format!("publication failed: {}", error));
                    return false;
                }
            }
        }
        debug("acquisition timed out");
        false
    }

    fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            a.dev() == b.dev() && a.ino() == b.ino() && a.modified().ok() == b.modified().ok()
        }
        #[cfg(not(unix))]
        {
            a.modified().ok() == b.modified().ok() && a.len() == b.len()
        }
    }

    fn stale(&self, data: Option<&Value>, stat: &fs::Metadata) -> bool {
        let timestamp = data
            .and_then(|d| d.get("timestamp"))
            .and_then(Value::as_u64);
        let pid = data.and_then(|d| d.get("pid")).and_then(Value::as_u64);
        let (Some(timestamp), Some(pid)) =
            (timestamp, pid.filter(|p| *p > 0 && *p <= i32::MAX as u64))
        else {
            return stat
                .modified()
                .ok()
                .and_then(|m| m.elapsed().ok())
                .is_some_and(|age| age >= Duration::from_secs(3));
        };
        let hostname = crate::launch_owner::hostname();
        if data.and_then(|d| d.get("hostname")).and_then(Value::as_str) == Some(&hostname) {
            if !crate::launch_owner::process_alive(pid) {
                return true;
            }
            if let Some((state, start)) = Self::process_info(pid) {
                if state == "Z"
                    || state == "X"
                    || state == "x"
                    || data
                        .and_then(|d| d["processStart"].as_str())
                        .is_some_and(|s| s != start)
                {
                    return true;
                }
            }
            #[cfg(target_os = "linux")]
            if self.monitor_owner && data.and_then(|d| d["processStart"].as_str()).is_none() {
                if let Ok(command) = fs::read_to_string(format!("/proc/{}/cmdline", pid)) {
                    return !command.contains("cpu-penalty-monitor")
                        && !command.contains("__start-cpu-monitor");
                }
            }
            return false;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        now.saturating_sub(timestamp) > 60000
    }

    fn process_info(pid: u64) -> Option<(String, String)> {
        #[cfg(target_os = "linux")]
        {
            let stat = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
            let fields: Vec<&str> = stat[stat.rfind(')')? + 2..].split_whitespace().collect();
            Some((fields.first()?.to_string(), fields.get(19)?.to_string()))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = pid;
            None
        }
    }

    pub fn release(&mut self) {
        if let Some(token) = self.token.take() {
            let data = fs::read_to_string(&self.path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok());
            if data
                .as_ref()
                .and_then(|d| d.get("token"))
                .and_then(Value::as_str)
                == Some(&token)
            {
                let _ = fs::remove_file(&self.path);
            }
        }
    }
}

impl Drop for LockManager {
    fn drop(&mut self) {
        self.release();
    }
}
