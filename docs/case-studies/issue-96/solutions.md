# Solutions: Issue #96

## Problem Statement

Quick-completing commands (like `agent --version`) run through screen isolation
produce no output. The screen session exits cleanly but the log file is empty.

---

## Solutions Considered

### Option A: Add `sleep` after the command in screen

**Approach:** Append `; sleep 0.1` to every command run in screen to give the log a
chance to flush before the session exits.

**Pros:** Simple, one-line change.

**Cons:**
- Slows every command by at least 100ms (unacceptable for interactive use)
- Hacky — fights symptoms rather than addressing the root cause
- Still a race condition (just smaller)

### Option B: Retry reading the log file with exponential backoff

**Approach:** After detecting session completion, if the log file is empty, retry
reading it up to 3 times with 10ms, 20ms, 40ms delays.

**Pros:** Addresses the TOCTOU race condition for the tee fallback path.

**Cons:**
- Does NOT fix the native logging path's `log_flush = 10` issue
- Adds complexity to the polling logic
- Still a race for very slow systems

### Option C: Use a temporary screenrc with `logfile flush 0` + `-L -Logfile` (v0.24.9)

**Approach:** For the native logging path (`-L -Logfile`, screen ≥ 4.5.1), create a
temporary screenrc file containing `logfile flush 0` and pass it to screen via the
`-c` option. For older screen (< 4.5.1), fall back to tee with retry.

This was the initial fix in PR #97 / v0.24.9, but it **did not resolve the issue on
macOS with screen 4.00.03** because:
- The tee fallback path was still unreliable
- The `logfile flush 0` screenrc only helped screen ≥ 4.5.1 (native logging)
- On macOS, the tee pipe's TOCTOU race was larger than the 50ms retry window

### Option D: Use `script` instead of screen's `-L`

**Approach:** Replace screen's log capture with `script -c "command" logfile`, which
uses a pty and has more reliable flush-on-exit behavior.

**Pros:** `script` is designed for output capture and handles flush correctly.

**Cons:**
- `script` behavior varies significantly between Linux (util-linux) and macOS (BSD)
- macOS `script` uses different flags (`-q`, `-c` not available)
- Complex to handle cross-platform
- Loses screen's session management features

### Option E: Unified screenrc-based logging for ALL versions (CHOSEN, v0.25.0)

**Approach:** Replace both the native `-L -Logfile` path AND the tee fallback with a
single screenrc-based approach that works on ALL screen versions:

```
logfile /path/to/output.log    # sets log file path (works since early screen)
logfile flush 0                # immediate flush (no 10-second buffer)
deflog on                      # enable logging for all new windows
```

Then run: `screen -dmS <session> -c <screenrc> <shell> -c '<command>'`

No `-L`, no `-Logfile`, no tee — just screenrc directives that are available
since the earliest screen versions.

**Pros:**
- Works identically on ALL screen versions (tested on 4.00.03 through 4.09.01)
- Eliminates both the native flush delay AND the tee pipe race condition
- No version detection needed for the logging strategy
- screen's own logging mechanism handles all buffer management correctly
- `deflog on` enables logging at session start, before any output is produced
- `logfile flush 0` ensures bytes hit disk immediately
- Clean implementation — no tee subprocess, no pipe buffering issues

**Cons:**
- The `-c` option overrides the user's `~/.screenrc` — but since we only use
  logging directives, there's no conflict for our detached-session use case

---

## Chosen Solution: Option E (unified screenrc logging)

**Implementation:**

```js
// Create temporary screenrc with logging configuration
const screenrcContent = [
  `logfile ${logFile}`,       // custom log file path
  'logfile flush 0',          // immediate flush
  'deflog on',                // enable logging for all windows
].join('\n');
fs.writeFileSync(screenrcFile, screenrcContent);

// Run screen with screenrc-only logging (no -L, no -Logfile, no tee)
const screenArgs = ['-dmS', sessionName, '-c', screenrcFile, shell, shellArg, command];
```

**Additional improvements in this fix:**
1. **Exit code capture**: The command is wrapped as `<cmd>; echo $? > /tmp/exit-file`
   to capture the real exit code (previously always reported as 0)
2. **Enhanced retry logic**: 3 retries with increasing delays (50ms, 100ms, 200ms)
   instead of a single 50ms retry
3. **Better debug output**: Debug messages respond to both `START_DEBUG` and
   `START_VERBOSE`, use `[screen-isolation]` prefix for easy filtering

**Why this is correct:**
- `logfile`, `logfile flush`, and `deflog on` are standard screenrc directives
  documented in the GNU Screen manual, available since early versions
- The approach directly addresses the root cause (output not captured) by using
  screen's own logging mechanism consistently
- No external process (tee) or version-specific CLI flags are involved
- The fix was verified on both Linux (screen 4.09.01) and the approach is
  compatible with macOS (screen 4.00.03) based on screenrc directive availability

**Key insight:** The original fix (Option C) treated the native logging and tee
fallback as separate paths needing separate fixes. Option E unifies them by
recognizing that screenrc directives (`logfile`, `deflog on`) work across all
versions, eliminating the need for version-dependent branching entirely.
