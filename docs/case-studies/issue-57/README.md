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

## Solution

### JavaScript Fix

Change from `exit` event to `close` event in `js/src/bin/cli.js`:

```javascript
// Before (problematic):
child.on('exit', (code) => {
  // Handle completion
  process.exit(exitCode);
});

// After (fixed):
child.on('close', (code) => {
  // Handle completion - all stdio data guaranteed to be received
  process.exit(exitCode);
});
```

### Rust Fix

The Rust implementation doesn't have this issue because `Command::output()` waits for the process to complete and returns all output:

```rust
let output = Command::new(&shell)
    .args(&shell_args)
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit())
    .output();
```

However, note that `Stdio::inherit()` means output goes directly to parent's stdout/stderr, bypassing capture. For the Rust version, the output is already being displayed in real-time via `inherit`, so the finish block appears after the process completes.

The Rust implementation may need review to ensure consistent behavior with the JavaScript version in terms of output capture and display.

## Testing

Tests should verify:
1. Direct execution mode shows output for `echo hi`
2. Direct execution mode shows finish block
3. Output appears between start and finish blocks
4. Exit code is correctly captured
5. Log file contains the command output

These tests should run on all platforms including macOS in CI.

## References

- [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html)
- [Bun Issue #18239](https://github.com/oven-sh/bun/issues/18239)
- [Bun Issue #24690](https://github.com/oven-sh/bun/issues/24690)
- [GitHub Issue #57](https://github.com/link-foundation/start/issues/57)
