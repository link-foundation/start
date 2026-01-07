# Case Study: Issue #60 - `$ --status` shows "executing" for finished commands

## Summary

The `$ --status <uuid>` command shows status "executing" for commands that have already finished. This happens because execution records stored in the database are not always updated when:
1. The process is killed or interrupted before normal completion
2. Historical records from before v0.17.3 (Issue #57 fix) were never updated
3. The process terminates abnormally (crash, SIGKILL, etc.)

## Symptoms

**Observed behavior:**
```
konard@MacBook-Pro-Konstantin ~ % $ --status 14a0e075-3de1-4342-97cd-f87c8cd66dda
14a0e075-3de1-4342-97cd-f87c8cd66dda
  uuid 14a0e075-3de1-4342-97cd-f87c8cd66dda
  pid 33834
  status executing              <- Should be "executed"
  command "echo hi"
  logPath /var/folders/cl/.../start-command-...log
  startTime "2026-01-07T18:06:04.729Z"
  workingDirectory /Users/konard
  shell /bin/zsh
  platform darwin
  options
    substitutionMatched false
    runtime Bun
    runtimeVersion 1.2.20
```

**Expected behavior:**
```
status executed
exitCode 0
endTime "2026-01-07T18:06:04.900Z"
```

## Timeline of Events

1. User runs a command with `$ echo hi`
2. CLI creates an ExecutionRecord with status "executing" and saves to database
3. Command spawns and executes
4. **Issue occurs**: If the process is killed (Ctrl+C, SIGTERM, terminal closed), the record stays as "executing"
5. Later, `$ --status <uuid>` queries the record and shows stale "executing" status

## Root Cause Analysis

### Primary Root Cause: Missing Signal Handlers

The JavaScript implementation did not have signal handlers to update execution status when the process is interrupted:

```javascript
// Before fix: No signal handlers
// Process killed → status never updated

// After fix: Signal handlers update status on interruption
process.on('SIGINT', () => {
  cleanupExecution('SIGINT', 130);
  process.exit(130);
});
```

When a command is running and the user presses Ctrl+C:
1. SIGINT is sent to the process
2. Node.js/Bun terminates the process immediately
3. The execution record remains with status "executing"
4. Future `--status` queries show the incorrect status

### Secondary Root Cause: Historical Records from Issue #57

Issue #57 showed that on macOS with Bun, the event loop could exit before the "close" event fired, preventing the status update from being saved. While this was fixed in v0.17.3, any records created before that fix remain stale.

### Related Issue #57 Context

Issue #57 identified that Bun's event loop could exit before `node:child_process` events fire on macOS. The fix used `Bun.spawn` with async/await for reliable stream handling. However, this fix didn't address:
- Commands run before the fix was deployed
- Commands terminated by signals

## Solution

### Fix 1: Signal Handlers for Graceful Cleanup

Added signal handlers to update execution status when the process is interrupted:

```javascript
// Global reference to current execution record
let currentExecutionRecord = null;

function cleanupExecution(signal, exitCode) {
  if (currentExecutionRecord && executionStore) {
    currentExecutionRecord.complete(exitCode);
    executionStore.save(currentExecutionRecord);
    currentExecutionRecord = null;
  }
}

// SIGINT (Ctrl+C) - exit code 130 (128 + 2)
process.on('SIGINT', () => {
  cleanupExecution('SIGINT', 130);
  process.exit(130);
});

// SIGTERM (kill command) - exit code 143 (128 + 15)
process.on('SIGTERM', () => {
  cleanupExecution('SIGTERM', 143);
  process.exit(143);
});

// SIGHUP (terminal closed) - exit code 129 (128 + 1)
process.on('SIGHUP', () => {
  cleanupExecution('SIGHUP', 129);
  process.exit(129);
});
```

### Fix 2: Stale Record Cleanup Command

Added `--cleanup` and `--cleanup-dry-run` CLI options to clean up stale records:

```bash
# See what would be cleaned (dry run)
$ --cleanup-dry-run

# Actually clean up stale records
$ --cleanup
```

The cleanup logic detects stale records by:
1. Checking if the PID is still running (if on same platform)
2. Checking if the record has exceeded max age (default: 24 hours)

Stale records are marked as "executed" with exit code -1 to indicate abnormal termination.

```javascript
cleanupStale(options = {}) {
  const maxAgeMs = options.maxAgeMs || 24 * 60 * 60 * 1000; // 24 hours

  for (const record of executingRecords) {
    // Check if process is still running
    if (record.pid && record.platform === process.platform) {
      try {
        process.kill(record.pid, 0); // Signal 0 checks if process exists
      } catch {
        // Process doesn't exist - record is stale
        isStale = true;
      }
    }

    // Check age
    const age = Date.now() - new Date(record.startTime).getTime();
    if (age > maxAgeMs) {
      isStale = true;
    }
  }
}
```

## Files Changed

1. `js/src/bin/cli.js`:
   - Added signal handlers for SIGINT, SIGTERM, SIGHUP
   - Added `currentExecutionRecord` global reference for cleanup
   - Added `handleCleanup()` function
   - Updated `printUsage()` with new options

2. `js/src/lib/args-parser.js`:
   - Added `--cleanup` and `--cleanup-dry-run` option parsing
   - Added `cleanup` and `cleanupDryRun` to `wrapperOptions`

3. `js/src/lib/execution-store.js`:
   - Added `cleanupStale()` method to detect and clean stale records

4. `js/test/execution-store.test.js`:
   - Added tests for `cleanupStale()` functionality

5. `js/test/args-parser.test.js`:
   - Added tests for `--cleanup` and `--cleanup-dry-run` options

## Testing

### Unit Tests

All tests pass:
- `cleanupStale()` correctly detects stale records by PID
- `cleanupStale()` correctly detects stale records by age
- `cleanupStale()` with dry run doesn't modify records
- `cleanupStale()` with actual cleanup marks records as "executed"
- `--cleanup` and `--cleanup-dry-run` options parse correctly

### Manual Testing Scenarios

1. **Normal execution**: Run `$ echo hi`, verify status shows "executed"
2. **Ctrl+C interruption**: Run `$ sleep 10`, press Ctrl+C, verify status shows "executed" with exit code 130
3. **Terminal close**: Run command in terminal, close terminal, check status shows "executed" with exit code 129
4. **Cleanup stale records**: Create old records, run `$ --cleanup-dry-run`, then `$ --cleanup`

## Prevention

To prevent this issue from recurring:

1. **Signal handling**: Always register signal handlers for long-running processes
2. **Cleanup mechanism**: Provide a way to clean up stale records
3. **Process tracking**: Use PID to verify if a process is actually still running

## References

- [GitHub Issue #60](https://github.com/link-foundation/start/issues/60)
- [GitHub Issue #57](https://github.com/link-foundation/start/issues/57) - Related macOS event loop issue
- [GitHub PR #59](https://github.com/link-foundation/start/pull/59) - Bun.spawn fix for Issue #57
- [Signal Handling Best Practices](https://nodejs.org/api/process.html#signal-events)
- [Unix Exit Codes](https://tldp.org/LDP/abs/html/exitcodes.html) - Exit code conventions (128 + signal number)
