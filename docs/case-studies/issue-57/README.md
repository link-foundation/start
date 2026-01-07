# Case Study: Issue #57 - `$ echo 'hi'` does not finish on macOS without isolation

## Summary

The `$ echo 'hi'` command without isolation mode fails to display output and finish block on macOS. The command appears to hang indefinitely showing only the start block, while the same command with `--isolated screen` works correctly.

## Symptoms

**Observed behavior (non-isolation mode on macOS):**
```
konard@MacBook-Pro-Konstantin ~ % $ echo 'hi'
╭──────────────────────────────────────────────────────────╮
│ Session ID: a83e19f4-0794-4ee6-a654-4dd6c0087566         │
│ Starting at 2026-01-07 17:03:44.221: echo hi             │
╰──────────────────────────────────────────────────────────╯

<hangs - no output, no finish block>
```

**Expected behavior (shown with screen isolation):**
```
konard@MacBook-Pro-Konstantin ~ % $ --isolated screen -- echo 'hi'
╭──────────────────────────────────────────────────────────╮
│ Session ID: 7f173d08-6c5f-45dc-8781-52bbd51ac641         │
│ Starting at 2026-01-07 17:03:50.663: echo hi             │
│ [Isolation] Environment: screen, Mode: attached          │
╰──────────────────────────────────────────────────────────╯

hi

╭──────────────────────────────────────────────────────────╮
│ Screen session "screen-..." exited with code 0          │
│ Finished at 2026-01-07 17:03:50.968 in 0.402 seconds     │
│ Exit code: 0                                             │
│ Log: /var/folders/.../start-command-...log               │
│ Session ID: 7f173d08-6c5f-45dc-8781-52bbd51ac641         │
╰──────────────────────────────────────────────────────────╯
```

## Timeline of Events

1. User runs `$ echo 'hi'` on macOS
2. CLI parses arguments, generates session ID
3. `runDirect()` function is called
4. Start block is printed (works correctly)
5. Child process is spawned with `stdio: ['inherit', 'pipe', 'pipe']`
6. `data` event handlers are attached to `stdout` and `stderr`
7. `exit` event handler is attached to handle process completion
8. **Child process executes `echo 'hi'` and exits almost immediately**
9. **Race condition**: On macOS, the `exit` event may fire before stdout data events
10. **Result**: The process exits, but `process.exit()` in the exit handler terminates before stdout data arrives

## Root Cause Analysis

### The Problem: `exit` vs `close` Event

The JavaScript implementation in `js/src/bin/cli.js` uses the `exit` event to handle process completion:

```javascript
child.on('exit', (code) => {
  // ... handle completion and call process.exit(exitCode)
});
```

According to [Node.js documentation](https://nodejs.org/api/child_process.html):

> The `'close'` event is emitted when the stdio streams of a child process have been closed. This is distinct from the `'exit'` event, since multiple processes might share the same stdio streams.

The key insight is:
- **`exit` event**: Fires when the process terminates, but data may still be buffered in stdio streams
- **`close` event**: Fires after all stdio streams have been closed and all data has been received

On macOS (especially with fast commands like `echo`), the timing works as follows:
1. The process exits quickly
2. The `exit` event fires immediately
3. `process.exit()` is called in the handler
4. The Node.js/Bun process terminates
5. The `data` events for stdout never fire because the process already exited

### Why Screen Isolation Works

Screen isolation uses a different execution model:
1. It spawns a detached screen session with log capture
2. It polls for session completion every 100ms
3. It reads the log file to get output
4. Only then does it print the finish block

This approach doesn't have the same race condition because it reads from a file after the command completes, not from a stream during execution.

### Related Issues

Several Bun-specific issues have been reported related to stdout/stderr buffering on macOS:

1. [Bun Issue #18239](https://github.com/oven-sh/bun/issues/18239): `process.stdin` on macOS buffers all input instead of emitting chunks incrementally
2. [Bun Issue #24690](https://github.com/oven-sh/bun/issues/24690): `Bun.spawn()` with `stdout: 'pipe'` returns empty output in test runner

## Solution Attempts

### Initial Fix (v0.17.2): Using `close` event

The initial fix changed from `exit` event to `close` event in `js/src/bin/cli.js`:

```javascript
// Before (problematic):
child.on('exit', (code) => {
  // Handle completion
  process.exit(exitCode);
});

// After (v0.17.2):
child.on('close', (code) => {
  // Handle completion - all stdio data guaranteed to be received
  process.exit(exitCode);
});
```

**Result**: This fix did NOT work on macOS. User testing showed the issue persisted.

### Deeper Root Cause Analysis (v0.17.3)

After further investigation, we discovered the actual root cause is related to **Bun's event loop behavior**, not just the event type:

1. **Bun Issue #3083**: `node:child_process#spawn` doesn't fire `close` event if app exits immediately after spawned app exits ([GitHub](https://github.com/oven-sh/bun/issues/3083))

2. The issue is that Bun's event loop may exit **before** the `close` event callback can be scheduled, especially for fast commands like `echo`.

3. This explains why:
   - The start block appears (synchronous code)
   - No output appears (async stream data never received)
   - No finish block appears (`close` event never fires)
   - The shell prompt returns (Bun process exits without waiting)

### Final Fix (v0.17.3): Using Bun.spawn with async/await

The proper fix uses **Bun's native `Bun.spawn` API** instead of `node:child_process`:

```javascript
// New approach: Use Bun.spawn for reliable event handling
if (typeof Bun !== 'undefined') {
  // Bun runtime - use native API
  const proc = Bun.spawn([shell, ...shellArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'inherit',
  });

  // Read streams using async/await (blocks until complete)
  const stdoutContent = await new Response(proc.stdout).text();
  const stderrContent = await new Response(proc.stderr).text();

  // Wait for process to exit
  const exitCode = await proc.exited;

  // Now safe to print finish block and exit
} else {
  // Node.js - fallback to event-based approach
  const child = spawn(shell, shellArgs, { ... });
  child.on('close', (code) => { ... });
}
```

**Why this works**:
1. `await proc.exited` keeps the event loop alive until the process exits
2. Reading streams with async readers ensures all data is consumed
3. The Promise-based approach doesn't have the callback scheduling issues

### Rust Implementation

The Rust implementation uses `spawn()` with threads for real-time output, which correctly waits for completion:

```rust
let mut child = Command::new(&shell)
    .args(&shell_args)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()?;

// Threads read stdout/stderr in real-time
let stdout_handle = thread::spawn(move || { ... });
let stderr_handle = thread::spawn(move || { ... });

// Wait for threads and process
stdout_handle.join();
stderr_handle.join();
child.wait();  // This blocks until completion
```

This approach doesn't have the event loop issue because Rust's threads naturally wait for completion.

## Testing

Tests should verify:
1. Direct execution mode shows output for `echo hi`
2. Direct execution mode shows finish block
3. Output appears between start and finish blocks
4. Exit code is correctly captured
5. Log file contains the command output

These tests should run on all platforms including macOS in CI.

## Addendum: CI/CD Changelog Fragment Check Bug

### Discovery

During the PR review for Issue #57 (PR #58), a critical bug was discovered in the CI/CD pipeline: the Rust changelog fragment check was passing even when code was changed but no changelog fragment was added.

### Bug Location

File: `.github/workflows/rust.yml`, in the `changelog` job's "Check for changelog fragments" step.

### Root Cause

The check used `exit 0` (success) instead of `exit 1` (failure) when detecting missing changelog fragments:

```yaml
# Original code (BUGGY):
if [ "$SOURCE_CHANGED" -gt 0 ] && [ "$FRAGMENTS" -eq 0 ]; then
  echo "::warning::No changelog fragment found..."
  exit 0  # BUG: Should be exit 1 to fail the check!
fi
```

This meant:
1. Code changes were correctly detected
2. Missing changelog fragment was correctly detected
3. A warning was displayed (which appears in GitHub Actions logs)
4. But the job still passed with exit code 0
5. Other jobs (like `test`) that depended on `changelog` proceeded as if everything was fine

### Impact

- PRs with Rust code changes could be merged without changelog fragments
- The changelog check appeared to work (showed warnings) but didn't actually block PRs
- This undermines the changelog policy enforcement for the Rust implementation

### Contrast with JavaScript Workflow

The JavaScript workflow uses a separate validation script (`scripts/validate-changeset.mjs`) that correctly exits with code 1 when no changeset is found:

```javascript
if (changesetCount === 0) {
  console.error("::error::No changeset found...");
  process.exit(1);  // CORRECT: Fails the check
}
```

### Fix Applied

Changed the Rust workflow to properly fail:

```yaml
# Fixed code:
if [ "$SOURCE_CHANGED" -gt 0 ] && [ "$FRAGMENTS" -eq 0 ]; then
  echo "::error::No changelog fragment found..."  # Changed from ::warning:: to ::error::
  exit 1  # Fixed: Now properly fails the check
fi
```

Changes made:
1. Changed `exit 0` to `exit 1` to fail the job
2. Changed `::warning::` to `::error::` for consistent GitHub Actions annotation

### Evidence

CI Run: https://github.com/link-foundation/start/actions/runs/20790282454/job/59710582348

The log shows the job passed with "Changelog check passed" because the condition was not met at the time (no source changes were detected in that specific comparison). However, before commit `30f15eb` added `rust/changelog.d/57.md`, the check would have passed with `exit 0` even if it detected missing fragments.

### Timeline

1. Commit `0e750e6`: Original fix for Issue #57 - changes `rust/src/bin/main.rs`
2. Commit `d38a67f`: Added JS changeset (`js/.changeset/fix-macos-stdout-capture.md`)
3. CI Run 20790282454: Rust changelog check passes (bug masked because Rust fragment was added in next commit)
4. Commit `30f15eb`: Added Rust changelog fragment (`rust/changelog.d/57.md`)
5. User feedback: Noticed that CI check shouldn't have passed before `30f15eb`

### Lessons Learned

1. **Always test failure paths**: The changelog check was never tested to ensure it actually fails when it should
2. **Use consistent approaches**: The JS workflow uses a proper validation script, while Rust uses inline shell commands with a subtle bug
3. **Verify CI annotations**: Using `::warning::` instead of `::error::` was a hint that the check might not be enforced
4. **Code review**: Shell scripts in YAML can hide subtle bugs like wrong exit codes

## References

- [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html)
- [Bun Issue #3083](https://github.com/oven-sh/bun/issues/3083): `close` event not firing
- [Bun Issue #18239](https://github.com/oven-sh/bun/issues/18239): macOS stdin buffering
- [Bun Issue #24690](https://github.com/oven-sh/bun/issues/24690): stdout pipe issues in tests
- [Bun Spawn Documentation](https://bun.sh/docs/api/spawn)
- [GitHub Issue #57](https://github.com/link-foundation/start/issues/57)
- [GitHub PR #58](https://github.com/link-foundation/start/pull/58): Initial fix attempt
- [GitHub PR #59](https://github.com/link-foundation/start/pull/59): Final fix with Bun.spawn
- [CI Run 20790282454](https://github.com/link-foundation/start/actions/runs/20790282454/job/59710582348)
