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

### Option E: Unified screenrc-based logging for ALL versions (v0.25.0 — FAILED on macOS)

**Approach:** Replace both the native `-L -Logfile` path AND the tee fallback with a
single screenrc-based approach that works on ALL screen versions:

```
logfile /path/to/output.log    # sets log file path (works since early screen)
logfile flush 0                # immediate flush (no 10-second buffer)
deflog on                      # enable logging for all new windows
```

Then run: `screen -dmS <session> -c <screenrc> <shell> -c '<command>'`

**Result:** Failed on macOS. `deflog on` only applies to windows created AFTER
screenrc processing. In `-dmS` mode, the default window is created BEFORE screenrc
is processed. The initial window never has logging enabled.

### Option F: `-L` flag + screenrc logging directives (CHOSEN, current fix)

**Approach:** Add the `-L` command-line flag to explicitly enable logging for the
initial window, combined with screenrc directives for configuration:

```
screen -dmS <session> -L -c <screenrc> <shell> -c '<command>'
```

Where the screenrc contains:
```
logfile /path/to/output.log    # sets log file path
logfile flush 0                # immediate flush
deflog on                      # enable logging for any additional windows
```

**Pros:**
- `-L` enables logging for the initial window at creation time (before screenrc)
- `-L` is available on ALL screen versions (including macOS 4.00.03)
- Combined with `logfile <path>` in screenrc, `-L` logs to our custom path
- `logfile flush 0` ensures immediate flush
- No need for `-Logfile` CLI option (4.5.1+) or tee fallback
- Clean, single code path for all screen versions

**Cons:**
- The `-c` option overrides the user's `~/.screenrc` — but since we only use
  logging directives, there's no conflict for our detached-session use case

---

## Chosen Solution: Option F (`-L` flag + screenrc)

**Implementation:**

```js
// Create temporary screenrc with logging configuration
const screenrcContent = [
  `logfile ${logFile}`,       // custom log file path
  'logfile flush 0',          // immediate flush
  'deflog on',                // enable logging for additional windows
].join('\n');
fs.writeFileSync(screenrcFile, screenrcContent);

// Run screen with -L flag (enables logging for initial window)
// + screenrc (sets log path and flush behavior)
const screenArgs = ['-dmS', sessionName, '-L', '-c', screenrcFile, shell, shellArg, command];
```

**Additional improvements:**
1. **Exit code capture**: The command is wrapped as `<cmd>; echo $? > /tmp/exit-file`
   to capture the real exit code (previously always reported as 0)
2. **Enhanced retry logic**: 3 retries with increasing delays (50ms, 100ms, 200ms)
   instead of a single 50ms retry
3. **`--verbose` flag support**: Args parser now handles `--verbose` and sets
   `START_VERBOSE=1` so screen-isolation debug output is visible
4. **Lazy debug evaluation**: DEBUG is now a function (`isDebug()`) so env vars
   set after module load (by `--verbose` flag) are respected

**Why this is correct:**
- `-L` is the standard screen flag for enabling logging, available since early versions
- `logfile` in screenrc sets the custom path (no need for `-Logfile` CLI option)
- `-L` enables logging at window creation time (before any output is produced)
- `logfile flush 0` ensures bytes hit disk immediately
- The approach directly addresses the root cause: `deflog on` only applies to NEW
  windows, but `-L` applies to the INITIAL window

**Key insight from v0.25.0 failure:** `deflog on` means "all **new** windows"
not "all windows." The default window in `-dmS` mode is not "new" from the
screenrc's perspective — it already exists when screenrc is processed. The `-L`
flag is needed to bridge this gap.
