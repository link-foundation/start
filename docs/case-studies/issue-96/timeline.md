# Timeline: Issue #96

## Reproduction Command
```
$ --isolated screen -- agent --version
```

## User Environment
- macOS (Apple Silicon / Intel)
- GNU Screen 4.0.3 (bundled with macOS — older than 4.5.1 threshold)
- OR: Linux with GNU Screen ≥ 4.5.1 where the race condition still exists under load

---

## Sequence of Events (Tee Fallback Path — macOS Screen 4.0.3)

### Step 1: CLI parses command
```
$ --isolated screen -- agent --version
```
→ `command = "agent --version"`, `isolated = "screen"`, `mode = "attached"`

### Step 2: `runScreenWithLogCapture()` is called
- `supportsLogfileOption()` returns `false` (screen 4.0.3 < 4.5.1)
- Tee fallback path chosen
- `effectiveCommand = "(agent --version) 2>&1 | tee \"/tmp/screen-output-...log\""`
- Screen starts: `screen -dmS session /bin/zsh -c "(agent --version) 2>&1 | tee logfile"`

### Step 3: Screen session runs the command (t ≈ 0ms)
- Screen starts its internal process
- `agent --version` executes (very fast, ≈ 5ms)
- `agent` writes `0.13.2\n` to stdout
- The tee pipe receives the output and writes it to the log file
- The zsh process exits
- Screen detects child exit and terminates the session
- Screen session is gone (t ≈ 50ms total)

### Step 4: Our poller first checks at t = 100ms
- `execSync('screen -ls')` runs
- Session name NOT found → session is done
- `fs.readFileSync(logFile)` reads the log file

### Step 5 (BUG): Log file is empty or missing
**Root cause 1 (screen ≥ 4.5.1, native logging path):**
- Screen writes to a libc `FILE*` buffer via `fwrite`
- GNU Screen's `log_flush` defaults to 10 seconds
- With `log_flush = 10`, `WLogString()` in `ansi.c` does NOT call `logfflush` after each write
- The periodic flush timer fires at t = 10,000ms, but the session terminated at t ≈ 50ms
- If `fclose` is called properly in `Finit()→FreeWindow()→logfclose()`, libc's `fclose`
  should flush the buffer (POSIX guarantees `fclose` flushes before closing)
- However: on macOS with Homebrew screen / system screen, the `fclose` may be called from
  a signal handler or cleanup path that uses `_exit()` instead of `exit()`, bypassing
  stdio buffer flushing entirely

**Root cause 2 (screen < 4.5.1, tee fallback path):**
- The tee pipe's output buffering may not be complete when the screen session exits
- The log file may exist but contain 0 bytes at the moment of reading
- This is a TOCTOU (time-of-check-time-of-use) race condition

### Step 6: Empty output displayed
- `output.trim()` is falsy (empty string)
- Nothing is written to `process.stdout`
- The version string `0.13.2` is silently lost

---

## Sequence of Events (Native Logging Path — Screen ≥ 4.5.1)

### Step 3 (detail): Screen's internal log buffer
- Screen writes `0.13.2\r\n` to its internal `FILE*` log buffer via `logfwrite()`
- With default `log_flush = 10`, `WLogString()` does NOT call `logfflush()`
- The session exits before the 10-second flush timer fires
- If `Finit()` calls `fclose()` via the normal exit path, the buffer IS flushed (POSIX)
- BUT: if any signal handler calls `_exit()`, the buffer is NOT flushed

This explains why the issue is **intermittent** — it depends on whether screen exits
via the normal `exit()` code path or a signal-triggered `_exit()` path.

---

## Verified Behavior (Linux, Screen 4.09.01)
On Linux with screen 4.09.01, the issue does NOT reproduce reliably because:
1. The `fclose` path is taken in `logfclose()`, flushing the stdio buffer
2. The tee fallback is not used (native logging is available)
3. The fix (logfile flush 0) ensures the buffer is always flushed immediately

The issue is most reproducible on macOS where the tee fallback is used.
