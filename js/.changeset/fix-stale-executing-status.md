---
'start-command': patch
---

fix: Ensure execution status is updated when process is interrupted

This fix addresses Issue #60 where `$ --status` shows "executing" for finished commands.

Changes:

- Added signal handlers (SIGINT, SIGTERM, SIGHUP) to update execution status when process is interrupted
- Added `--cleanup` and `--cleanup-dry-run` flags to clean up stale records from crashed/killed processes
- Added `cleanupStale()` method to ExecutionStore to detect and clean stale records

The cleanup logic detects stale records by:

1. Checking if the PID is still running (if on same platform)
2. Checking if the record has exceeded max age (default: 24 hours)

Stale records are marked as "executed" with exit code -1 to indicate abnormal termination.
