# start-command

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
