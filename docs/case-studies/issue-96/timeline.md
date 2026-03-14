# Timeline: Issue #96

## Reproduction Command
```
$ --isolated screen -- agent --version
```

## User Environment
- macOS (Apple Silicon / Intel)
- GNU Screen 4.00.03 (bundled with macOS — older than 4.5.1 threshold)
- zsh 5.9
- `agent` installed via `bun install -g start-command`

---

## Fix Iteration 1: v0.24.9 / PR #97

### Hypothesis
The issue was attributed to two root causes:
1. **Native logging** (screen ≥ 4.5.1): `log_flush = 10` (10-second buffer delay)
2. **Tee fallback** (screen < 4.5.1): TOCTOU race when reading the log file

### Fix Applied
- Native path: `logfile flush 0` in screenrc + `-c` option
- Tee path: Single 50ms retry when log file is empty

### Result: Partial failure
The fix worked on Linux (screen 4.09.01) but NOT on macOS (screen 4.00.03).
User confirmed: "Fix didn't work."

---

## Fix Iteration 2: v0.25.0 / PR #98

### Investigation

#### Key observations from user's report
1. macOS screen 4.00.03 → uses tee fallback (not native logging)
2. Output is blank between `$ agent --version` and `✓` (exit 0)
3. `--verbose` flag shows isolation metadata but no screen debug output
4. The `START_DEBUG` env var was separate from `--verbose` CLI flag

#### Experiments conducted
1. **test-screen-capture-issue96.js**: Verified both paths work on Linux
2. **test-screen-tee-forced.js**: Confirmed tee fallback works on Linux
3. **test-screen-screenrc-logging.js**: Discovered `deflog on` + `logfile <path>`
   works WITHOUT `-L` or `-Logfile` flags on ALL screen versions

#### Key discovery
Screen's `logfile` and `deflog on` screenrc directives are available since early
screen versions (pre-4.0). By using:
```
logfile /path/to/output.log
logfile flush 0
deflog on
```
in a screenrc file, we can enable logging with a custom path on ANY screen version —
completely eliminating the need for `-Logfile` (CLI option, 4.5.1+) or tee fallback.

#### Additional discoveries
1. **Exit code always 0**: The code always reported `exitCode: 0` regardless of
   command outcome. Fixed by saving `$?` to a sidecar file.
2. **Debug output gap**: `--verbose` CLI flag set `START_VERBOSE` but screen-isolation
   only checked `START_DEBUG`. Fixed to respond to both.

### Fix Applied
- Unified screenrc-based logging for ALL screen versions
- Exit code capture via sidecar file
- Enhanced retry logic (3 retries, 50/100/200ms)
- Debug output responds to both START_DEBUG and START_VERBOSE

### Result: Partial failure (again)
The fix worked on Linux (screen 4.09.01) but NOT on macOS (screen 4.00.03).
User confirmed: "Fix didn't work." — output is still blank.

---

## Fix Iteration 3: PR #98 (continued)

### Investigation
The v0.25.0 fix relied on `deflog on` in screenrc to enable logging. However,
`deflog on` only applies to windows created AFTER the screenrc is processed.

In `screen -dmS` mode, the default window is created BEFORE screenrc processing.
This means the initial window (where the command runs) never had logging enabled.

**Key insight:** The word "new" in GNU Screen's documentation is critical:
`deflog on` sets "the default log state for all **new** windows."
The initial window is not "new" — it's already created when screenrc runs.

### Fix Applied
- Added `-L` flag to screen invocation: `screen -dmS session -L -c screenrc ...`
- `-L` explicitly enables logging for the initial window at creation time
- `-L` is available on ALL screen versions (including macOS 4.00.03)
- Combined with `logfile <path>` in screenrc, `-L` logs to our custom path
- `deflog on` is kept for any additional windows that might be created
- Added `--verbose` flag support in args parser (sets `START_VERBOSE=1`)
- Made DEBUG evaluation lazy (function) so `--verbose` flag works at runtime

---

## Sequence of Events (Current Fix — `-L` + Screenrc)

### Step 1: CLI parses command
```
$ --isolated screen -- agent --version
```
→ `command = "agent --version"`, `isolated = "screen"`, `mode = "attached"`

### Step 2: `runScreenWithLogCapture()` is called
- Creates screenrc with `logfile`, `logfile flush 0`, `deflog on`
- Wraps command: `agent --version; echo $? > /tmp/screen-exit-xxx.code`
- Starts: `screen -dmS session -L -c /tmp/screenrc-xxx /bin/zsh -c '...'`
  (note the `-L` flag which enables logging for the initial window)

### Step 3: Screen session runs
- Screen creates initial window with logging ENABLED (due to `-L` flag)
- Screen reads screenrc: `logfile` sets custom path, `logfile flush 0` sets immediate flush
- `/bin/zsh -c '...'` runs `agent --version`
- Output is written to screen's virtual terminal
- Screen's logger captures output and flushes immediately (logfile flush 0)
- Exit code is written to sidecar file via `echo $?`
- Shell exits, screen terminates session

### Step 4: Poller detects session completion (t ≈ 100ms)
- `screen -ls` no longer shows the session
- Reads log file — output is present (already flushed by screen)
- Reads exit code file — gets actual exit code
- Displays output and reports correct exit code

### Step 5: Cleanup
- Removes temporary screenrc, log file, and exit code file
