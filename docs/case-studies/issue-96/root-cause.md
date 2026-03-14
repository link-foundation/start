# Root Cause Analysis: Issue #96

## The Bug

`agent --version` (or any quick-completing command) run through screen isolation
produces no output, even though the command succeeds with exit code 0.

---

## Root Cause 1: GNU Screen's Periodic Log Flush (Native Logging Path, Screen ≥ 4.5.1)

### GNU Screen log flush architecture

GNU Screen's `-L` logging feature writes output to a libc `FILE*` buffer (not directly
to disk). Flush is controlled by the `log_flush` variable (default: `10` seconds):

```c
// src/screen.c
int log_flush = 10;

// src/ansi.c — WLogString (called for every logged character)
static void WLogString(Window *win, char *buf, size_t len)
{
    if (!win->w_log) return;
    logfwrite(win->w_log, buf, len);  // writes to FILE* buffer
    if (!log_flush)
        logfflush(win->w_log);        // only flushes immediately if log_flush == 0
}
```

With `log_flush = 10` (the default), `logfflush` is **not called** after each write.
Instead, the periodic flush timer fires every 10 seconds:

```c
// src/window.c — DoStartLog
SetTimeout(&logflushev, n * 1000);  // n = log_flush = 10
evenq(&logflushev);
```

For `agent --version` which runs in ~50ms, the screen session exits before this timer
ever fires.

### Why fclose should flush (but may not)

On graceful shutdown, `Finit()` → `FreeWindow()` → `logfclose()` → `fclose()` is called.
POSIX guarantees that `fclose()` flushes the stdio buffer before closing. So in the
**normal exit path**, data is not lost.

However, if screen is terminated via a signal that invokes `_exit()` rather than `exit()`,
stdio buffers are NOT flushed. This can happen when:
1. The child process terminates and screen receives SIGCHLD
2. Screen's signal handler calls `_exit()` directly in certain code paths

This makes the issue **intermittent** — it depends on the OS, screen version, and exact
timing of the signal handling.

---

## Root Cause 2: Tee Pipe Buffering Race (Tee Fallback, Screen < 4.5.1)

### macOS bundled screen 4.0.3

On macOS, the system-bundled GNU Screen is version 4.0.3, which predates the `-Logfile`
option (added in 4.5.1). The previous code fell back to:

```js
effectiveCommand = `(${effectiveCommand}) 2>&1 | tee "${logFile}"`;
```

The screen session ran:
```
screen -dmS session /bin/zsh -c "(agent --version) 2>&1 | tee /tmp/logfile"
```

### The race condition

When `agent --version` completes in ~5ms:
1. The agent process writes `0.13.2\n` to stdout
2. The tee process receives the data and writes it to the log file
3. The zsh process exits
4. Screen detects the child exit and terminates the session

The RACE: between step 2 (tee writes to OS page cache) and our poller reading the file,
there may be a brief window where:
- The log file exists but the `write()` syscall from tee hasn't been committed to the
  page cache yet (on some OS implementations)
- OR the file still has 0 bytes because tee's userspace buffer hasn't been `fwrite`'d
  yet when screen terminates it

This is a TOCTOU (time-of-check-time-of-use) race between the session appearing gone in
`screen -ls` and the log file having its complete content.

### Why the v0.24.9 retry fix was insufficient

The v0.24.9 fix added a single 50ms retry when the log file was empty. However, on macOS:
- The race window was larger than 50ms in many cases
- `tee` itself could be killed by screen before flushing its buffer
- The fundamental architecture of piping through tee in a detached session was inherently
  unreliable for fast-completing commands

---

## Root Cause 3: Exit Code Always Reported as 0

A secondary bug was discovered during the investigation: the screen isolation code
**always reported exit code 0** regardless of what happened inside the screen session.

```js
resolve({
  success: true,
  exitCode: 0,  // Always 0!
  message: `Screen session "${sessionName}" exited with code 0`,
});
```

This meant that even if `agent --version` failed (e.g., `agent` not in PATH inside
the screen session), the user would see exit code 0 and no output — making it
impossible to diagnose whether the issue was output capture or command execution.

---

## The Fix: Unified Screenrc-Based Logging

The root cause of both the native and tee paths was that they relied on mechanisms
that had reliability edge cases:
- Native `-Logfile`: buffer flush timing
- Tee: pipe buffering and process lifecycle

The fix replaces both with **screenrc-based logging**, using directives available
since early screen versions:

```
logfile /path/to/output.log    # sets custom log file path
logfile flush 0                # forces immediate flush
deflog on                      # enables logging for all new windows
```

This approach:
1. Uses screen's **own logging mechanism** consistently (no external tee process)
2. Sets the **log file path via screenrc** (no need for -Logfile CLI option)
3. Forces **immediate flush** (no 10-second buffer delay)
4. Enables logging **at session creation** (no race with output timing)
5. Works on **all screen versions** including macOS 4.00.03

Additionally:
- **Exit code capture** via `$?` saved to a sidecar file
- **Enhanced retry** with 3 attempts and increasing delays (50/100/200ms)
- **Better diagnostics** via `[screen-isolation]` debug prefix

---

## Test Coverage

Tests added specifically for this issue:
1. **Version-flag command output capture**: `node --version` output must be captured
2. **Exit code capture from failed commands**: `nonexistent_command` must report non-zero
3. **Stderr capture**: `echo "test" >&2` must appear in captured output
4. **Multi-line output with correct exit code**: Multiple echo commands with exit 0

Both JavaScript and Rust implementations have corresponding tests.
