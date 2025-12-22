# Case Study: Issue #15 - Screen Isolation Not Working As Expected

## Issue Summary

**Issue URL:** https://github.com/link-foundation/start/issues/15
**Date Reported:** 2025-12-22
**Reporter:** @konard
**Status:** Investigating

### Problem Statement

The screen isolation environment does not display command output when running in attached mode. When using `$ --isolated screen -- echo "hello"`, the expected output "hello" is not shown - instead, only `[screen is terminating]` appears.

### Environment

- **Platform:** macOS (reported), Linux (reproduced)
- **Package:** start-command@0.5.1
- **Screen version:** Tested with GNU Screen

## Timeline of Events

1. User installs start-command: `bun install -g start-command`
2. Direct command execution works: `$ echo "hello"` shows "hello"
3. Docker isolation works: `$ --isolated docker --image alpine -- echo "hello"` shows "hello"
4. Screen isolation fails: `$ --isolated screen -- echo "hello"` shows only `[screen is terminating]`

## Reproduction

### Observed Behavior

```
$ echo "hello"
[2025-12-22 13:45:05.245] Starting: echo hello
hello
[2025-12-22 13:45:05.254] Finished
Exit code: 0

$ --isolated docker --image alpine -- echo "hello"
[2025-12-22 13:45:07.847] Starting: echo hello
[Isolation] Environment: docker, Mode: attached
[Isolation] Image: alpine
hello
Docker container "docker-..." exited with code 0
[2025-12-22 13:45:08.066] Finished
Exit code: 0

$ --isolated screen -- echo "hello"
[2025-12-22 13:45:11.134] Starting: echo hello
[Isolation] Environment: screen, Mode: attached
[screen is terminating]
Screen session "screen-..." exited with code 0
[2025-12-22 13:45:11.199] Finished
Exit code: 0
```

**Notice:** No "hello" output in the screen isolation case, though exit code is 0.

## Root Cause Analysis

### Investigation

1. **TTY Requirement**: The GNU Screen command requires a connected terminal (TTY/PTY) to run in attached mode.

2. **Node.js spawn behavior**: When spawning processes with `child_process.spawn()`, even with `stdio: 'inherit'`, Node.js does not always provide a proper pseudo-terminal (PTY) that screen requires.

3. **Error in non-TTY environments**: Running `screen -S session shell -c command` without a TTY results in:

   ```
   Must be connected to a terminal.
   ```

4. **Detached mode works**: Running `screen -dmS session shell -c command` works because it doesn't require an attached terminal.

### Experimental Evidence

Testing revealed:

- `process.stdin.isTTY` and `process.stdout.isTTY` are `undefined` when running from Node.js
- Detached mode with logging (`screen -dmS ... -L -Logfile ...`) captures output correctly
- Using `script -q -c "screen ..." /dev/null` can provide a PTY but includes terminal escape codes

### Comparison with Docker

Docker isolation works because:

1. Docker run with `-it` flags handles terminal attachment
2. Docker spawns an isolated container that manages its own pseudo-terminal
3. The command output flows through Docker's I/O handling

## Solution Options

### Option 1: Use Script Command for PTY Allocation (Recommended)

Wrap the screen command with `script -q -c "command" /dev/null` to allocate a pseudo-terminal.

**Pros:**

- Provides a real PTY that screen requires
- Works across Linux/macOS
- Maintains attached behavior

**Cons:**

- Adds terminal escape codes to output
- Requires `script` command to be available

### Option 2: Switch to Detached Mode with Log Capture

Run screen in detached mode (`-dmS`) with logging enabled (`-L -Logfile`), wait for completion, then display the log.

**Pros:**

- Clean output without escape codes
- Reliable across platforms
- Captures full command output

**Cons:**

- Not truly "attached" - user can't interact with the process
- Requires polling or waiting for completion

### Option 3: Hybrid Approach (Chosen Solution)

For attached mode:

1. Check if running in a TTY (`process.stdin.isTTY`)
2. If TTY available: Use standard screen spawn with `stdio: 'inherit'`
3. If no TTY: Use `script` command to allocate PTY

For detached mode:

- Use existing implementation with `-dmS` flags

## Implementation

The fix modifies `src/lib/isolation.js` to:

1. Check for TTY availability before spawning screen
2. Use `script` command as PTY allocator when no TTY is available
3. Clean terminal escape codes from output when using script wrapper
4. Maintain compatibility with existing detached mode

## Testing Strategy

1. **Unit tests**: Test TTY detection logic
2. **Integration tests**: Test screen isolation in detached mode
3. **Environment tests**: Test behavior with and without TTY

## References

- [GNU Screen Manual](https://www.gnu.org/software/screen/manual/screen.html)
- [Stack Overflow: Must be connected to terminal](https://stackoverflow.com/questions/tagged/gnu-screen+tty)
- [node-pty for PTY allocation](https://github.com/microsoft/node-pty)
- [script command man page](https://man7.org/linux/man-pages/man1/script.1.html)

## Appendix: Test Logs

See accompanying log files:

- `test-output-1.log` - Initial reproduction
- `screen-modes-test.log` - Screen modes investigation
- `screen-attached-approaches.log` - Solution approaches testing
