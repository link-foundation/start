//! Serialize snapshots separately from the execution store and bound disk usage.
use crate::docker_cleanup::docker_command;
use crate::execution_control::CommandRunner;
use crate::isolation::isolation_log::shell_quote;
use crate::store_lock::LockManager;
use serde_json::Value;
use std::path::PathBuf;

const GIB: u64 = 1024 * 1024 * 1024;
pub const SNAPSHOT_IMAGE_LABEL: &str = "start-command.snapshot-image";

pub fn acquire_snapshot_lock() -> Result<LockManager, String> {
    let path = std::env::var_os("START_SNAPSHOT_LOCK")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(unix) {
                PathBuf::from("/tmp/start-command-docker-snapshot.lock")
            } else {
                std::env::temp_dir().join("start-command-docker-snapshot.lock")
            }
        });
    let mut lock = LockManager::new(path);
    // Same-host LockManager ownership uses PID liveness, not the 60s stale
    // age used for other hosts. Long commits keep their serialization lock.
    if !lock.acquire(1000) {
        return Err(
            "A Docker snapshot resume is in progress on this host. Retry after it finishes.".into(),
        );
    }
    Ok(lock)
}

pub fn containerd_root(config: &str) -> String {
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            break;
        }
        if let Some((key, value)) = line.split_once('=') {
            let value = value.trim();
            if key.trim() == "root" && (value.starts_with('"') || value.starts_with('\'')) {
                let quote = value.chars().next().unwrap();
                if let Some(end) = value[1..].find(quote) {
                    return value[1..end + 1].into();
                }
            }
        }
    }
    "/var/lib/containerd".into()
}

fn default_containerd_root() -> Result<String, String> {
    if let Ok(root) = std::env::var("START_CONTAINERD_ROOT") {
        return Ok(root);
    }
    match std::fs::read_to_string("/etc/containerd/config.toml") {
        Ok(config) => Ok(containerd_root(&config)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(containerd_root("")),
        Err(e) => Err(format!(
            "Cannot read containerd storage configuration: {}",
            e
        )),
    }
}

pub fn preflight_snapshot<R: CommandRunner + ?Sized>(
    name: &str,
    runner: &R,
) -> Result<String, String> {
    preflight_snapshot_with(name, runner, None, &|root| {
        let result = runner.run("df", &["-Pk".into(), root.into()]);
        if !result.success {
            return Err(format!(
                "Cannot check free disk at {}: {}",
                root,
                result.stderr.trim()
            ));
        }
        result
            .stdout
            .lines()
            .last()
            .and_then(|line| line.split_whitespace().nth(3))
            .and_then(|s| s.parse::<u64>().ok())
            .and_then(|n| n.checked_mul(1024))
            .ok_or_else(|| format!("Cannot determine free disk at {}", root))
    })
}

pub fn preflight_snapshot_with<R: CommandRunner + ?Sized>(
    name: &str,
    runner: &R,
    containerd_override: Option<&str>,
    free: &dyn Fn(&str) -> Result<u64, String>,
) -> Result<String, String> {
    let docker = docker_command().to_string_lossy().to_string();
    let result = runner.run(
        &docker,
        &[
            "inspect".into(),
            "--size".into(),
            "--format".into(),
            "{{.SizeRw}}".into(),
            name.into(),
        ],
    );
    let size = result
        .stdout
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|_| result.success)
        .ok_or("Cannot determine the writable layer size; refusing Docker snapshot resume.")?;
    let result = runner.run(
        &docker,
        &["info".into(), "--format".into(), "{{json .}}".into()],
    );
    let info: Value = serde_json::from_str(&result.stdout).unwrap_or(Value::Null);
    let root = info
        .get("DockerRootDir")
        .and_then(Value::as_str)
        .filter(|root| !root.is_empty() && result.success)
        .ok_or("Cannot determine Docker data root; refusing Docker snapshot resume.")?;
    let mut roots = vec![root.to_string()];
    if info
        .get("DriverStatus")
        .is_some_and(|d| d.to_string().contains("io.containerd.snapshotter"))
    {
        let root = match containerd_override {
            Some(root) => root.to_string(),
            None => default_containerd_root()?,
        };
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    let required = size
        .checked_mul(2)
        .and_then(|n| n.checked_add(10 * GIB))
        .ok_or("Snapshot size exceeds the supported range.")?;
    for root in roots {
        let available = free(&root)?;
        if available < required {
            return Err(format!("Insufficient disk at {}: need {:.2} GiB (2 × writable layer plus reserve), available {:.2} GiB. Docker snapshot resume refused.", root, required as f64 / GIB as f64, available as f64 / GIB as f64));
        }
    }
    Ok(format!(
        "[Resume] snapshotting {:.2} GiB; disk preflight passed ({:.2} GiB required).",
        size as f64 / GIB as f64,
        required as f64 / GIB as f64
    ))
}

pub fn snapshot_image_cleanup_snippets(name: &str, redirection: &str) -> (String, String) {
    let format = shell_quote(&format!(
        "{{{{index .Config.Labels \"{}\"}}}}",
        SNAPSHOT_IMAGE_LABEL
    ));
    (format!("__start_snapshot_image=$(docker inspect -f {} {} 2>/dev/null || true)", format, shell_quote(name)),
     format!("case \"$__start_snapshot_image\" in start-command-resume/*) docker rmi \"$__start_snapshot_image\" {} || true;; esac", redirection))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution_control::CommandRunOutput;
    use std::cell::RefCell;

    struct Runner;
    impl CommandRunner for Runner {
        fn run(&self, _bin: &str, args: &[String]) -> CommandRunOutput {
            CommandRunOutput {
                success: true,
                stdout: if args[0] == "info" {
                    "{\"DockerRootDir\":\"/docker\",\"DriverStatus\":[[\"driver-type\",\"io.containerd.snapshotter.v1\"]]}".into()
                } else {
                    (8 * GIB).to_string()
                },
                ..Default::default()
            }
        }
    }

    #[test]
    fn checks_both_roots_and_refuses_insufficient_containerd_disk() {
        let checked = RefCell::new(vec![]);
        let error = preflight_snapshot_with("box", &Runner, Some("/containerd"), &|root| {
            checked.borrow_mut().push(root.to_string());
            Ok(if root == "/docker" {
                100 * GIB
            } else {
                25 * GIB
            })
        })
        .unwrap_err();
        assert!(error.contains("/containerd"));
        assert_eq!(*checked.borrow(), vec!["/docker", "/containerd"]);
    }

    #[test]
    fn reads_only_top_level_containerd_root() {
        assert_eq!(
            containerd_root("root = '/custom'\n[plugins]\nroot = '/wrong'"),
            "/custom"
        );
    }
}
