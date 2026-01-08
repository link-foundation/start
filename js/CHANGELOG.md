# start-command

## 0.19.0

### Minor Changes

- 112a78e: Replace fixed-width box output with status spine format
  - Width-independent output that doesn't truncate or create jagged boxes
  - All metadata visible and copy-pasteable (log paths, session IDs)
  - Works uniformly in TTY, tmux, SSH, CI, and log files
  - Clear visual distinction: │ for metadata, $ for command, no prefix for output
  - Result markers ✓ and ✗ for success/failure
  - Isolation metadata repeated in footer for context

## 0.18.0

### Minor Changes

- c918e82: feat: Use OS-matched default Docker image when --image is not specified

  When using `$ --isolated docker -- command`, instead of requiring the `--image` option,
  the system now automatically selects an appropriate default Docker image based on the
  host operating system:
  - macOS/Windows: `alpine:latest` (lightweight, portable)
  - Ubuntu: `ubuntu:latest`
  - Debian: `debian:latest`
  - Arch Linux: `archlinux:latest`
  - Fedora: `fedora:latest`
  - CentOS/RHEL: `centos:latest`
  - Other Linux/Fallback: `alpine:latest`

  This allows users to use Docker isolation with a simple command like:
  `$ --isolated docker -- echo 'hi'`

  Fixes #62

## 0.17.4

### Patch Changes

- 89d04d6: fix: Ensure execution status is updated when process is interrupted

  This fix addresses Issue #60 where `$ --status` shows "executing" for finished commands.

  Changes:
  - Added signal handlers (SIGINT, SIGTERM, SIGHUP) to update execution status when process is interrupted
  - Added `--cleanup` and `--cleanup-dry-run` flags to clean up stale records from crashed/killed processes
  - Added `cleanupStale()` method to ExecutionStore to detect and clean stale records

  The cleanup logic detects stale records by:
  1. Checking if the PID is still running (if on same platform)
  2. Checking if the record has exceeded max age (default: 24 hours)

  Stale records are marked as "executed" with exit code -1 to indicate abnormal termination.

## 0.17.3

### Patch Changes

- a61f1a9: fix: Use Bun.spawn for reliable stdout capture on macOS (Issue #57)

  The previous fix (v0.17.2) using `close` event instead of `exit` did not resolve the issue on macOS. After deeper investigation, we discovered the root cause: Bun's event loop may exit before the `close` event callback can be scheduled, especially for fast commands like `echo`.

  This fix uses Bun's native `Bun.spawn` API with async/await for stream handling when running on Bun runtime. This approach keeps the event loop alive until all streams are consumed and the process exits.
  - Use `Bun.spawn` instead of `node:child_process` when running on Bun
  - Use async stream readers with `getReader()` for real-time output display
  - Use `await proc.exited` to ensure process completion before exiting
  - Fall back to `node:child_process` with `close` event for Node.js compatibility
  - Add verbose logging with `--verbose` flag for debugging

## 0.17.2

### Patch Changes

- d38a67f: fix: Use 'close' event instead of 'exit' for reliable stdout capture on macOS

  The 'exit' event fires when the process terminates, but stdio streams may still have buffered data. On macOS, fast-executing commands like 'echo hi' could exit before stdout data events fired, causing no output to be displayed and no finish block shown.
  - Changed from 'exit' to 'close' event in JavaScript for reliable output capture
  - Updated Rust to use piped stdout/stderr with threads for real-time display and capture
  - Added case study documentation for Issue #57 root cause analysis

## 0.17.1

### Patch Changes

- 82a5297: fix: Improve output uniformity and ensure echo hi works in all modes
  - Fixed truncation of log paths, session IDs, and result messages in output blocks
  - Added consistent empty line formatting before/after command output
  - Ensured proper output display in screen isolation mode
  - Added integration tests for echo command across all isolation modes

## 0.17.0

### Minor Changes

- 1da275c: feat: Improve output block uniformity and add OS-based Docker image detection
  - Move isolation info lines into start block instead of printing them separately
  - Move exit/result messages into finish block instead of printing them separately
  - Add getDefaultDockerImage() to detect host OS and select matching Docker image
  - Default Docker images: ubuntu, debian, archlinux, fedora, centos based on host OS

## 0.16.0

### Minor Changes

- 35f3505: feat: Improve command output formatting with human-readable timestamps and duration
  - Changed timestamp format from `[timestamp] Starting:` to `Starting at timestamp:`
  - Changed finish message from `[timestamp] Finished` to `Finished at timestamp in X.XXX seconds`
  - Added performance metric showing command execution duration
  - Added `formatDuration` helper function for consistent duration formatting

## 0.15.0

### Minor Changes

- 102dbe2: Add dual storage system for command execution tracking using links notation

  This update implements a comprehensive execution tracking system that stores information about each called command:

  **New Features:**
  - Dual storage system: text (.lino files) via lino-objects-codec and binary (.links) via clink
  - Each execution record includes:
    - UUID of the command call
    - Process ID (PID) for process management
    - Status (executing/executed)
    - Exit code
    - Log file path
    - Working directory, shell, platform info
    - Additional execution options and metadata
  - File-based locking mechanism to ensure single-writer access
  - Verification system to check consistency between text and binary databases
  - Integration with clink's string aliases for readable identifiers

  **Configuration:**
  - `START_DISABLE_TRACKING=1` - Disable execution tracking
  - `START_APP_FOLDER` - Custom folder for storing execution records
  - `START_VERBOSE=1` - Show execution IDs during command execution

  **Dependencies:**
  - Added `lino-objects-codec` for links notation serialization
  - Optional `clink` CLI tool for binary database support

  **Testing:**
  - 24 new unit tests for execution store operations
  - CI/CD updated to install clink for integration testing on Linux and macOS
