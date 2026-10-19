//! Serialize snapshots separately from the execution store and bound disk usage.
use crate::docker_cleanup::docker_command;
use crate::execution_control::CommandRunner;
use crate::isolation::isolation_log::shell_quote;
use crate::store_lock::LockManager;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const GIB: u64 = 1024 * 1024 * 1024;
pub const SNAPSHOT_IMAGE_LABEL: &str = "start-command.snapshot-image";

/// sysexits.h EX_TEMPFAIL: the resume can succeed when retried later.
pub const EX_TEMPFAIL: i32 = 75;

/// A refused snapshot; `exit_code` is [`EX_TEMPFAIL`] when retrying can help.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotFailure {
    pub message: String,
    pub exit_code: Option<i32>,
}

impl SnapshotFailure {
    fn tempfail(message: String) -> Self {
        Self {
            message,
            exit_code: Some(EX_TEMPFAIL),
        }
    }
}

impl From<String> for SnapshotFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            exit_code: None,
        }
    }
}

impl From<&str> for SnapshotFailure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

/// Seconds as the wait messages print them: "600s", "1.5s".
pub fn format_seconds(seconds: f64) -> String {
    format!("{}s", (seconds * 1000.0).round() / 1000.0)
}

fn default_lock_path() -> PathBuf {
    std::env::var_os("START_SNAPSHOT_LOCK")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(unix) {
                PathBuf::from("/tmp/start-command-docker-snapshot.lock")
            } else {
                std::env::temp_dir().join("start-command-docker-snapshot.lock")
            }
        })
}

fn notify_stderr(line: &str) {
    eprintln!("{}", line);
}

/// How to take the host-wide snapshot lock (issue #224).
pub struct SnapshotLockRequest<'a> {
    pub lock_path: Option<PathBuf>,
    /// Container about to be snapshotted, published for other waiters.
    pub holder: Option<&'a str>,
    /// Wait this long for a busy lock; 0 fails at once.
    pub wait_seconds: f64,
    pub notify: &'a dyn Fn(&str),
}

impl Default for SnapshotLockRequest<'_> {
    fn default() -> Self {
        Self {
            lock_path: None,
            holder: None,
            wait_seconds: 0.0,
            notify: &notify_stderr,
        }
    }
}

pub fn acquire_snapshot_lock() -> Result<LockManager, String> {
    acquire_snapshot_lock_with(&SnapshotLockRequest::default()).map_err(|e| e.message)
}

/// Take the snapshot lock, waiting `wait_seconds` for a busy one. The wait is
/// announced once with the holder's name.
pub fn acquire_snapshot_lock_with(
    request: &SnapshotLockRequest,
) -> Result<LockManager, SnapshotFailure> {
    let path = request.lock_path.clone().unwrap_or_else(default_lock_path);
    let mut lock = LockManager::new(path);
    if let Some(holder) = request.holder {
        lock = lock.with_metadata("holder", Value::from(holder));
    }
    // Same-host LockManager ownership uses PID liveness, not the 60s stale
    // age used for other hosts. Long commits keep their serialization lock.
    let wait_ms = (request.wait_seconds.max(0.0) * 1000.0) as u64;
    if lock.acquire(if wait_ms == 0 {
        1000
    } else {
        wait_ms.min(1000)
    }) {
        return Ok(lock);
    }
    let holder = lock
        .read_lock_file()
        .and_then(|data| data.get("holder").and_then(Value::as_str).map(String::from));
    let busy = match &holder {
        Some(holder) => format!(
            "A Docker snapshot resume of {} is in progress on this host.",
            holder
        ),
        None => "A Docker snapshot resume is in progress on this host.".to_string(),
    };
    if wait_ms <= 1000 {
        return Err(SnapshotFailure::tempfail(format!(
            "{} Retry after it finishes, or wait for it with --snapshot-wait <seconds>.",
            busy
        )));
    }
    let waited = format_seconds(wait_ms as f64 / 1000.0);
    (request.notify)(&format!(
        "[Resume] Waiting up to {} for the snapshot of {} to finish before snapshotting {}.",
        waited,
        holder.as_deref().unwrap_or("another container"),
        request.holder.unwrap_or("this container")
    ));
    if lock.acquire(wait_ms - 1000) {
        return Ok(lock);
    }
    Err(SnapshotFailure::tempfail(format!(
        "{} Still busy after waiting {}; retry after it finishes.",
        busy, waited
    )))
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

/// Free bytes at `root` according to `df -Pk`.
pub fn df_free_bytes<R: CommandRunner + ?Sized>(runner: &R, root: &str) -> Result<u64, String> {
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
}

pub fn preflight_snapshot<R: CommandRunner + ?Sized>(
    name: &str,
    runner: &R,
) -> Result<String, String> {
    preflight_snapshot_with(name, runner, None, &|root| df_free_bytes(runner, root))
}

pub fn preflight_snapshot_with<R: CommandRunner + ?Sized>(
    name: &str,
    runner: &R,
    containerd_override: Option<&str>,
    free: &dyn Fn(&str) -> Result<u64, String>,
) -> Result<String, String> {
    let options = PreflightOptions {
        containerd_root: containerd_override,
        ..Default::default()
    };
    preflight_snapshot_guarded(name, runner, &options, free).map_err(|e| e.message)
}

fn sleep_for(duration: Duration) {
    std::thread::sleep(duration);
}

fn monotonic_seconds() -> f64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

/// Options of the disk preflight (issue #224).
pub struct PreflightOptions<'a> {
    /// Writable-layer size to use instead of `docker inspect --size`.
    pub size_hint: Option<u64>,
    /// Re-check free disk this long instead of refusing at once.
    pub disk_wait_seconds: f64,
    /// Poll interval; defaults to START_SNAPSHOT_DISK_POLL or 10 seconds.
    pub disk_poll_seconds: Option<f64>,
    pub containerd_root: Option<&'a str>,
    pub notify: &'a dyn Fn(&str),
    pub sleep: &'a dyn Fn(Duration),
    /// Monotonic clock in seconds.
    pub now: &'a dyn Fn() -> f64,
}

impl Default for PreflightOptions<'_> {
    fn default() -> Self {
        Self {
            size_hint: None,
            disk_wait_seconds: 0.0,
            disk_poll_seconds: None,
            containerd_root: None,
            notify: &notify_stderr,
            sleep: &sleep_for,
            now: &monotonic_seconds,
        }
    }
}

fn measure_writable_layer<R: CommandRunner + ?Sized>(
    name: &str,
    runner: &R,
    docker: &str,
    size_hint: Option<u64>,
) -> Result<(u64, Option<&'static str>), SnapshotFailure> {
    if let Some(size) = size_hint {
        return Ok((size, Some("size hint")));
    }
    let result = runner.run(
        docker,
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
    Ok((size, None))
}

fn image_store_roots<R: CommandRunner + ?Sized>(
    runner: &R,
    docker: &str,
    containerd_override: Option<&str>,
) -> Result<Vec<String>, SnapshotFailure> {
    let result = runner.run(
        docker,
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
    Ok(roots)
}

/// The first root without `required` free bytes, with what it has.
fn find_short_root(
    roots: &[String],
    required: u64,
    free: &dyn Fn(&str) -> Result<u64, String>,
) -> Result<Option<(String, u64)>, String> {
    for root in roots {
        let available = free(root)?;
        if available < required {
            return Ok(Some((root.clone(), available)));
        }
    }
    Ok(None)
}

fn gib(bytes: u64) -> f64 {
    bytes as f64 / GIB as f64
}

/// Refuse a snapshot that could fill the disk. The writable layer is measured
/// once (or taken from `size_hint`); with `disk_wait_seconds` free space is
/// re-checked every poll interval until it suffices. A disk that stays short
/// fails with [`EX_TEMPFAIL`].
pub fn preflight_snapshot_guarded<R: CommandRunner + ?Sized>(
    name: &str,
    runner: &R,
    options: &PreflightOptions,
    free: &dyn Fn(&str) -> Result<u64, String>,
) -> Result<String, SnapshotFailure> {
    let docker = docker_command().to_string_lossy().to_string();
    let (size, source) = measure_writable_layer(name, runner, &docker, options.size_hint)?;
    let roots = image_store_roots(runner, &docker, options.containerd_root)?;
    let required = size
        .checked_mul(2)
        .and_then(|n| n.checked_add(10 * GIB))
        .ok_or("Snapshot size exceeds the supported range.")?;
    let wait = options.disk_wait_seconds.max(0.0);
    let poll = options
        .disk_poll_seconds
        .or_else(|| {
            std::env::var("START_SNAPSHOT_DISK_POLL")
                .ok()
                .and_then(|value| value.parse::<f64>().ok())
        })
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .unwrap_or(10.0);
    let started = (options.now)();
    let mut waited = false;
    while let Some((root, available)) = find_short_root(&roots, required, free)? {
        let detail = format!(
            "Insufficient disk at {}: need {:.2} GiB (2 × writable layer plus reserve), available {:.2} GiB.",
            root,
            gib(required),
            gib(available)
        );
        let left = wait - ((options.now)() - started);
        if left <= 0.0 {
            return Err(SnapshotFailure::tempfail(if waited {
                format!(
                    "{} Still short after waiting {}; Docker snapshot resume refused.",
                    detail,
                    format_seconds(wait)
                )
            } else {
                format!("{} Docker snapshot resume refused.", detail)
            }));
        }
        if !waited {
            (options.notify)(&format!(
                "[Resume] Waiting up to {} for disk: {}",
                format_seconds(wait),
                detail
            ));
            waited = true;
        }
        (options.sleep)(Duration::from_secs_f64(poll.min(left)));
    }
    let measured = match source {
        Some(source) => format!("{:.2} GiB ({})", gib(size), source),
        None => format!("{:.2} GiB", gib(size)),
    };
    Ok(format!(
        "[Resume] snapshotting {}; disk preflight passed ({:.2} GiB required).",
        measured,
        gib(required)
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
