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

### Option C: Use a temporary screenrc with `logfile flush 0` (CHOSEN)

**Approach:** For the native logging path (`-L -Logfile`, screen ≥ 4.5.1), create a
temporary screenrc file containing `logfile flush 0` and pass it to screen via the
`-c` option.

```
echo "logfile flush 0" > /tmp/screen-rc-XXXX.rc
screen -dmS session -c /tmp/screen-rc-XXXX.rc -L -Logfile logfile shell -c command
```

`logfile flush 0` sets `log_flush = 0` in screen's internal state, which causes
`WLogString()` in `ansi.c` to call `logfflush()` (equivalent to `fflush()`) after
every write. This completely eliminates the 10-second buffering delay.

**Pros:**
- Eliminates the flush delay entirely for the native logging path
- Standard approach recommended in GNU Screen documentation
- No performance impact on the command itself (the flush is async in screen's event loop)
- Clean implementation — the temp file is created and deleted by our code
- Works on all screen versions that support the `-c` option (very old)

**Cons:**
- Requires creating/deleting an additional temp file per invocation
- The `-c` option overrides the user's `~/.screenrc` — but since we only put
  `logfile flush 0` in it, there's no conflict for our use case

**Note on the tee fallback path (screen < 4.5.1):**
The `logfile flush 0` setting in a screenrc also works on older screen versions (it's
a screenrc directive, not version-gated). However, for the tee fallback path, screen
itself doesn't write the log — `tee` does. So `logfile flush 0` doesn't help for
the tee path. For this path, Option B (retry) is added as a complementary fix.

### Option D: Use `script` instead of screen's `-L`

**Approach:** Replace screen's log capture with `script -c "command" logfile`, which
uses a pty and has more reliable flush-on-exit behavior.

**Pros:** `script` is designed for output capture and handles flush correctly.

**Cons:**
- `script` behavior varies significantly between Linux (util-linux) and macOS (BSD)
- macOS `script` uses different flags (`-q`, `-c` not available)
- Complex to handle cross-platform
- Loses screen's session management features

---

## Chosen Solution: Option C + Option B

**Implementation:**

For native logging path (screen ≥ 4.5.1):
```js
// Create temporary screenrc with immediate log flush
const screenrcFile = path.join(os.tmpdir(), `screenrc-${sessionName}`);
fs.writeFileSync(screenrcFile, 'logfile flush 0\n');

const logArgs = ['-dmS', sessionName, '-c', screenrcFile, '-L', '-Logfile', logFile];
screenArgs = [...logArgs, shell, shellArg, effectiveCommand];

// Clean up screenrc on completion
try { fs.unlinkSync(screenrcFile); } catch {}
```

For tee fallback path (screen < 4.5.1): add a brief retry when the log file is empty
immediately after session completion.

**Why this is correct:**
- Setting `logfile flush 0` is the standard, official way to control screen's log
  flush behavior, documented in the GNU Screen manual
- It directly addresses the root cause (buffered writes) rather than fighting symptoms
- The retry for the tee path handles the TOCTOU race for the remaining edge case
