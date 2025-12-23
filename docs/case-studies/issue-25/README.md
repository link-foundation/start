# Case Study: Issue #25 - Screen Isolation Output Missing

## Issue Summary

**Issue URL:** https://github.com/link-foundation/start/issues/25
**Date Reported:** 2025-12-23
**Reporter:** @konard
**Status:** Resolved

### Problem Statement

When running commands with screen isolation in attached mode (without `-d`/`--detached`), the command output is not displayed. Specifically:

```bash
$ --isolated screen --verbose -- echo "hello"
```

Shows `[screen is terminating]` but no "hello" output, even though the command executes successfully with exit code 0.

### Environment

- **Platform:** macOS 15.7.2
- **Package:** start-command@0.7.2
- **Screen version:** macOS bundled 4.00.03 (FAU) 23-Oct-06
- **Bun Version:** 1.2.20
- **Architecture:** arm64

## Timeline of Events

1. User installs start-command: `bun install -g start-command`
2. Direct command execution works: `$ echo "hello"` shows "hello"
3. Docker isolation works: `$ --isolated docker --image alpine -- echo "hello"` shows "hello"
4. **Screen isolation fails**: `$ --isolated screen -- echo "hello"` shows only `[screen is terminating]`

## Observed Behavior

### Expected

```
$ --isolated screen --verbose -- echo "hello"
[2025-12-23 20:56:28.265] Starting: echo hello

[Isolation] Environment: screen, Mode: attached

hello

Screen session "screen-1766523388276-4oecji" exited with code 0

[2025-12-23 20:56:28.362] Finished
Exit code: 0
```

### Actual (Before Fix)

```
$ --isolated screen --verbose -- echo "hello"
[2025-12-23 20:56:28.265] Starting: echo hello

[Isolation] Environment: screen, Mode: attached

[screen is terminating]

Screen session "screen-1766523388276-4oecji" exited with code 0

[2025-12-23 20:56:28.362] Finished
Exit code: 0
```

**Notice:** No "hello" output in the screen isolation case, though exit code is 0.

## Root Cause Analysis

### PRIMARY ROOT CAUSE: Shell Quoting Issues with execSync

The issue was in the `runScreenWithLogCapture` function in `src/lib/isolation.js`.

**The Problematic Code:**

```javascript
execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
  stdio: 'inherit',
});
```

This code constructs a shell command string by wrapping each argument in double quotes. However, when the command being executed already contains double quotes (like `echo "hello"`), the nested quoting breaks the shell parsing.

**Example of Broken Command:**

For the command `echo "hello"`:

1. `effectiveCommand` becomes: `(echo "hello") 2>&1 | tee "/tmp/...log"`
2. `screenArgs` is: `['-dmS', 'session-name', '/bin/sh', '-c', '(echo "hello") 2>&1 | tee "/tmp/...log"']`
3. After wrapping with `"${a}"`:
   ```
   screen "-dmS" "session-name" "/bin/sh" "-c" "(echo "hello") 2>&1 | tee "/tmp/...log""
   ```
4. **Problem**: The nested double quotes cause shell parsing errors - the shell sees `hello` as a separate token!

**Why Simple Commands Worked:**

Commands without quotes (like `echo hello` without the quotes) worked because there was no quoting conflict.

### Experimental Evidence

We created `experiments/test-screen-tee-debug.js` to test different approaches:

| Test   | Command                                         | Result                           |
| ------ | ----------------------------------------------- | -------------------------------- |
| Test 3 | `echo "hello"` (simple)                         | SUCCESS                          |
| Test 4 | `echo "hello from attached mode"` (with spaces) | **FAILED** - No log file created |
| Test 5 | Same with escaped quotes                        | SUCCESS                          |
| Test 6 | Using `spawnSync` with array                    | **SUCCESS**                      |

The experiments clearly showed that:

1. Commands with spaces in quoted strings fail with `execSync` + string construction
2. Using `spawnSync` with an array of arguments works correctly

### Why spawnSync Works

Node.js/Bun's `spawnSync` with array arguments:

- Passes arguments directly to the process without shell interpretation
- Each array element becomes a separate argv entry
- No shell quoting issues - the quotes in the command are preserved as-is

## The Solution

### Code Changes in `src/lib/isolation.js`

1. **Added `spawnSync` import:**

```javascript
const { execSync, spawn, spawnSync } = require('child_process');
```

2. **Replaced `execSync` with `spawnSync` in two locations:**

**Location 1: `runScreenWithLogCapture` function (attached mode with log capture)**

```javascript
// Before (broken):
execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
  stdio: 'inherit',
});

// After (fixed):
const result = spawnSync('screen', screenArgs, {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
```

**Location 2: `runInScreen` function (detached mode)**

```javascript
// Same pattern - replaced execSync with spawnSync
```

## Testing Strategy

### New Regression Tests Added

Two new tests were added to `test/isolation.test.js`:

1. **Test: should capture output from commands with quoted strings (issue #25)**
   - Tests: `echo "hello"`
   - Verifies the exact scenario from issue #25

2. **Test: should capture output from commands with complex quoted strings**
   - Tests: `echo "hello from attached mode"`
   - Verifies commands with spaces inside quotes work

### Test Results

All 25 isolation tests pass:

```
bun test test/isolation.test.js

  Captured quoted output: "hello"
  Captured complex quote output: "hello from attached mode"

 25 pass
 0 fail
```

## Key Learnings

1. **String construction for shell commands is fragile**: When building shell command strings, nested quoting can cause silent failures.

2. **Prefer array-based process spawning**: `spawnSync`/`spawn` with arrays are more robust than `execSync` with constructed strings.

3. **Test with varied input**: Simple commands may work while complex ones fail - test with real-world examples including quotes and spaces.

4. **Debug systematically**: Creating experiments (`test-screen-tee-debug.js`) helped isolate the exact failure mode.

## Connection to Previous Issues

This issue is related to Issue #15 (Screen Isolation Not Working As Expected) which addressed a different root cause:

- Issue #15: macOS Screen version incompatibility (lacking `-Logfile` option)
- Issue #25: Shell quoting issues in the tee fallback approach (used for older screen versions)

Both issues together ensure screen isolation works on:

- Modern screen (>= 4.5.1) with native `-Logfile` support
- Older screen (< 4.5.1, like macOS bundled 4.0.3) with tee fallback

## Files Modified

1. `src/lib/isolation.js` - Core fix: use `spawnSync` instead of `execSync`
2. `test/isolation.test.js` - Added 2 regression tests for issue #25
3. `experiments/test-screen-tee-fallback.js` - Experiment script (new)
4. `experiments/test-screen-tee-debug.js` - Debug experiment script (new)

## References

- [Node.js child_process.spawnSync](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)
- [GNU Screen Manual](https://www.gnu.org/software/screen/manual/screen.html)
- [Issue #15 Case Study](../issue-15/README.md)
- [Issue #22 Case Study](../issue-22/analysis.md)
