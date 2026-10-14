//! Regression tests for issue #222: `start --version | head -1` panicked with
//! "failed printing to stdout: Broken pipe" and exited 101. Like the
//! JavaScript edition, a closed stdout/stderr must neither panic nor change
//! the exit code: `--version` exits 0 and a command run keeps its own code.

#![cfg(unix)]

use std::os::fd::{FromRawFd, OwnedFd};
use std::path::Path;
use std::process::{Command, Stdio};

/// A pipe write end whose read end is already closed, so every write fails
/// with `EPIPE` deterministically (no race with a reader such as `head`).
fn closed_pipe() -> Stdio {
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let (read_end, write_end) =
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    drop(read_end);
    Stdio::from(write_end)
}

fn start(app_folder: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_start"));
    command
        .args(args)
        .env("START_APP_FOLDER", app_folder)
        .env("START_DISABLE_AUTO_ISSUE", "1")
        .env("START_DISABLE_LOG_UPLOAD", "1")
        .stdin(Stdio::null());
    command
}

/// Run with a closed stdout; returns the exit code and captured stderr.
fn run_with_closed_stdout(args: &[&str]) -> (i32, String) {
    let app_folder = tempfile::tempdir().unwrap();
    let output = start(app_folder.path(), args)
        .stdout(closed_pipe())
        .stderr(Stdio::piped())
        .output()
        .expect("failed to run the start binary");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

#[test]
fn version_with_closed_stdout_exits_zero_without_panic() {
    for args in [&["--version"][..], &["-v"], &["--version", "--verbose"]] {
        let (code, stderr) = run_with_closed_stdout(args);
        assert!(!stderr.contains("panicked"), "{args:?} panicked: {stderr}");
        assert_eq!(code, 0, "{args:?} exit code, stderr: {stderr}");
    }
}

#[test]
fn help_with_closed_stdout_exits_zero_without_panic() {
    let (code, stderr) = run_with_closed_stdout(&["--help"]);
    assert!(!stderr.contains("panicked"), "--help panicked: {stderr}");
    assert_eq!(code, 0, "--help exit code, stderr: {stderr}");
}

#[test]
fn command_with_closed_stdout_keeps_running_and_its_exit_code() {
    let (code, stderr) = run_with_closed_stdout(&["--", "sh", "-c", "seq 1 20000; exit 3"]);
    assert!(!stderr.contains("panicked"), "run panicked: {stderr}");
    assert_eq!(code, 3, "run exit code, stderr: {stderr}");
}

#[test]
fn command_with_closed_stdout_and_stderr_keeps_its_exit_code() {
    let app_folder = tempfile::tempdir().unwrap();
    let status = start(
        app_folder.path(),
        &["--", "sh", "-c", "seq 1 20000; seq 1 20000 >&2; exit 3"],
    )
    .stdout(closed_pipe())
    .stderr(closed_pipe())
    .status()
    .expect("failed to run the start binary");
    assert_eq!(status.code(), Some(3));
}
