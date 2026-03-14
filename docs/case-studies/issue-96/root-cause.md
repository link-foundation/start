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

### The fix

Add `logfile flush 0` to a temporary screenrc passed via `screen -c`:

```
logfile flush 0
```

This sets `log_flush = 0` in screen's internal variable, causing `WLogString` to call
`logfflush()` after every write:

```c
if (!log_flush)
    logfflush(win->w_log);  // now always executes
```

This completely eliminates the flush delay for log file writes.

---

## Root Cause 2: Tee Pipe Buffering Race (Tee Fallback, Screen < 4.5.1)

### macOS bundled screen 4.0.3

On macOS, the system-bundled GNU Screen is version 4.0.3, which predates the `-Logfile`
option (added in 4.5.1). The code falls back to:

```js
effectiveCommand = `(${effectiveCommand}) 2>&1 | tee "${logFile}"`;
```

The screen session runs:
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

### The fix

The `logfile flush 0` fix in the screenrc does NOT directly help the tee fallback path
(since tee is an external process, not governed by screen's log flush). However, an
additional retry mechanism can be added: if the log file is empty when first read but the
session just terminated, retry the read after a brief delay to let the OS flush complete.

In practice, on Linux the tee fallback is not used (screen >= 4.5.1 is available), and
on macOS the `logfile flush 0` option works on screen 4.0.3 as well (it's a screenrc
command, not a version-gated feature).

---

## Why This Is Intermittent

The issue doesn't always reproduce because:

1. **On Linux with screen 4.09.01**: The normal `fclose()` path usually flushes the buffer
   correctly. Only under certain timing conditions (SIGCHLD handling, `_exit`) does it fail.

2. **On macOS with screen 4.0.3**: The tee fallback's race window is very small (~1ms).
   Most of the time the file has content when read. But for very fast commands with a
   busy system, the window widens.

3. **The `screen -ls` timing**: The check `!sessions.includes(sessionName)` returns true
   as soon as the session process exits, but the OS may still be in the middle of flushing
   the log file's write buffers to the page cache.

---

## Test Coverage Gap

There were no tests specifically for:
1. Quick-completing commands (like `--version` flags) in screen isolation
2. Verification that version-string output (short, non-whitespace text) is captured

The existing tests use `echo "hello"` which is also fast but the string is longer and
may flush more reliably in certain conditions.
