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
}

impl LockManager {
    pub fn new(path: PathBuf) -> Self {
        Self { path, token: None }
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
                if Self::stale(data.as_ref(), &stat) {
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
                let data = json!({"pid": std::process::id(), "timestamp":
                    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
                    "hostname": local_hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default(),
                    "token": token});
                file.write_all(data.to_string().as_bytes())?;
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

    fn stale(data: Option<&Value>, stat: &fs::Metadata) -> bool {
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
            return !crate::launch_owner::process_alive(pid);
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        now.saturating_sub(timestamp) > 60000
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
