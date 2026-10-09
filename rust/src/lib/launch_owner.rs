//! Reservations survive a launcher crash without permanently blocking resume.
use crate::{execution_store::ExecutionRecord, local_hostname};
use serde_json::{json, Value};

pub fn mark_launch(record: &mut ExecutionRecord) {
    record.options.insert("launchPending".into(), json!(true));
    record.options.insert(
        "launchOwner".into(),
        json!({"pid":std::process::id(), "hostname":hostname()}),
    );
}

pub fn has_active_launch(record: &ExecutionRecord) -> bool {
    if record.options.get("launchPending").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    let Some(owner) = record.options.get("launchOwner") else {
        return true;
    };
    if owner["hostname"].as_str() != Some(&hostname()) {
        return true;
    }
    owner["pid"].as_u64().is_none_or(process_alive)
}

pub fn hostname() -> String {
    local_hostname::get()
        .map(|s| s.to_string_lossy().into())
        .unwrap_or_default()
}

pub fn process_alive(pid: u64) -> bool {
    if pid == 0 || pid > i32::MAX as u64 {
        return true;
    }
    #[cfg(unix)]
    {
        (unsafe { libc::kill(pid as i32, 0) }) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
            .output();
        match output {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).contains(&format!("\"{}\"", pid))
            }
            _ => true,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}
