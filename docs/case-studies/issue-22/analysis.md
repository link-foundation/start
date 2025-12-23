# Case Study: Issue #22 - Version Detection Issues

## Issue Overview

**Issue ID:** #22
**Title:** --version issues
**Reported By:** konard
**Created:** 2025-12-23T17:55:53Z
**Status:** Open

## Problem Summary

The `$ --version` command exhibited multiple issues when run on macOS:

1. **Screen version not detected** - Despite screen being installed, it showed "not installed"
2. **Wrong runtime displayed** - Showed Node.js version instead of Bun version
3. **Incorrect OS version format** - Showed OS Release (kernel version) instead of macOS version
4. **Argument parsing issue** - `$ --version --` resulted in "No command provided" error

## Timeline of Events

### User Environment

- **System:** macOS 15.7.2 (ProductVersion)
- **Kernel:** 24.6.0 (OS Release)
- **Bun Version:** 1.2.20
- **Node.js Emulation:** v24.3.0 (provided by Bun)
- **Architecture:** arm64
- **Package:** start-command@0.7.0

### Observed Behavior

#### Command 1: `$ --version --`

```
Error: No command provided
Usage: $ [options] [--] <command> [args...]
```

**Expected:** Should display version information (same as `$ --version`)
**Actual:** Treated `--` as command separator and found no command after it

#### Command 2: `$ --version`

```
start-command version: 0.7.0

OS: darwin
OS Release: 24.6.0
Node Version: v24.3.0
Architecture: arm64

Isolation tools:
  screen: not installed
  tmux: not installed
  docker: Docker version 28.5.1, build e180ab8
```

**Issues Identified:**

1. Screen shown as "not installed" despite being present
2. "Node Version: v24.3.0" when using Bun
3. "OS Release: 24.6.0" (kernel) instead of "15.7.2" (macOS version)

#### Verification Commands

```bash
screen -v
# Output: Screen version 4.00.03 (FAU) 23-Oct-06

sw_vers
# Output:
# ProductName:		macOS
# ProductVersion:	15.7.2
# BuildVersion:		24G325
```

## Root Cause Analysis

### Issue 1: Screen Version Not Detected

**Location:** `src/bin/cli.js:84`

**Root Cause:**

- Screen outputs version to stderr, not stdout
- Current implementation uses `execSync()` with default stdio configuration
- On some systems/versions, screen sends output to stderr

**Code Analysis:**

```javascript
const screenVersion = getToolVersion('screen', '--version');

function getToolVersion(toolName, versionFlag) {
  try {
    const result = execSync(`${toolName} ${versionFlag}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], // stderr is piped but not captured
      timeout: 5000,
    }).trim();
    // ...
```

The `execSync()` call captures stdout but the function doesn't merge stderr into the result. On macOS, screen may output to stderr.

### Issue 2: Node.js Version Instead of Bun Version

**Location:** `src/bin/cli.js:76`

**Root Cause:**

- Code uses `process.version` which returns Node.js compatibility version in Bun
- Bun emulates Node.js v24.3.0 for compatibility
- Should use `process.versions.bun` or `Bun.version` instead

**Code Analysis:**

```javascript
console.log(`Node Version: ${process.version}`);
```

**Research Findings:**

- `process.version` in Bun → Returns emulated Node.js version (v24.3.0)
- `process.versions.bun` → Returns actual Bun version (1.2.20)
- `Bun.version` → Bun-specific API for version

**Sources:**

- [Bun — Detect the Version at Runtime](https://futurestud.io/tutorials/bun-detect-the-version-at-runtime)
- [Get the current Bun version - Bun](https://bun.com/docs/guides/util/version)

### Issue 3: Incorrect macOS Version Format

**Location:** `src/bin/cli.js:75`

**Root Cause:**

- Code uses `os.release()` which returns kernel version (24.6.0)
- Should use `sw_vers -productVersion` for user-facing macOS version (15.7.2)

**Code Analysis:**

```javascript
console.log(`OS Release: ${os.release()}`);
```

**Kernel vs Product Version:**

- `os.release()` → 24.6.0 (Darwin kernel version)
- `sw_vers -productVersion` → 15.7.2 (macOS product version)

**Research Findings:**
The macOS `sw_vers` command provides user-facing version information:

- `sw_vers -productVersion` returns the macOS version (e.g., "15.7.2", "26.0")
- This is what users recognize as their macOS version

**Sources:**

- [sw_vers Man Page - macOS - SS64.com](https://ss64.com/mac/sw_vers.html)
- [Check macOS Latest Version · For Tahoe · 2025](https://mac.install.guide/macos/check-version)

### Issue 4: Argument Parsing for `--version --`

**Location:** `src/bin/cli.js:52-55`

**Root Cause:**

- Version check happens before argument parsing
- Only checks for exact match: `args.length === 1 && (args[0] === '--version' || args[0] === '-v')`
- When `--version --` is passed, args = `['--version', '--']`, length is 2, fails the check
- Falls through to argument parser which treats `--` as separator

**Code Analysis:**

```javascript
if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
  printVersion();
  process.exit(0);
}
```

**Expected Behavior:**

- `$ --version` → Show version ✓
- `$ --version --` → Show version (should ignore trailing `--`)
- `$ --` → "No command provided" error ✓
- `$` → Show usage ✓

## Proposed Solutions

### Solution 1: Fix Screen Detection

Capture both stdout and stderr when detecting tool versions:

```javascript
function getToolVersion(toolName, versionFlag) {
  try {
    const result = execSync(`${toolName} ${versionFlag} 2>&1`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const firstLine = result.split('\n')[0];
    return firstLine;
  } catch {
    return null;
  }
}
```

### Solution 2: Use Bun Version

Detect runtime and show appropriate version:

```javascript
// Detect if running in Bun
const runtime = typeof Bun !== 'undefined' ? 'Bun' : 'Node.js';
const runtimeVersion =
  typeof Bun !== 'undefined' ? Bun.version : process.version;

console.log(`${runtime} Version: ${runtimeVersion}`);
```

### Solution 3: Fix macOS Version Detection

Use `sw_vers -productVersion` on macOS:

```javascript
function getOSVersion() {
  if (process.platform === 'darwin') {
    try {
      return execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
    } catch {
      return os.release();
    }
  }
  return os.release();
}

console.log(`OS: ${process.platform}`);
console.log(`OS Version: ${getOSVersion()}`);
```

### Solution 4: Fix Argument Parsing

Check for `--version` flag regardless of other arguments:

```javascript
// Check if --version is present (ignore trailing --)
const hasVersionFlag = args.includes('--version') || args.includes('-v');
const isOnlyVersionWithSeparator =
  args.length === 2 &&
  (args[0] === '--version' || args[0] === '-v') &&
  args[1] === '--';

if ((args.length === 1 && hasVersionFlag) || isOnlyVersionWithSeparator) {
  printVersion();
  process.exit(0);
}
```

## Implementation Plan

1. **Fix argument parsing** - Handle `--version --` case
2. **Fix screen detection** - Capture stderr in version detection
3. **Replace Node with Bun** - Detect runtime and show correct version
4. **Fix OS version** - Use `sw_vers` on macOS
5. **Update REQUIREMENTS.md** - Remove npm references, emphasize Bun-first
6. **Add comprehensive tests** - Cover all version scenarios
7. **Ensure CI runs tests** - Validate quality

## Testing Strategy

### Test Cases Required

1. **Argument Parsing Tests:**
   - `$ --version` → Shows version
   - `$ -v` → Shows version
   - `$ --version --` → Shows version
   - `$ --` → Error: No command provided
   - `$` → Shows usage

2. **Screen Detection Tests:**
   - When screen installed → Shows version
   - When screen not installed → Shows "not installed"

3. **Runtime Detection Tests:**
   - Running with Bun → Shows "Bun Version: X.X.X"
   - Running with Node → Shows "Node.js Version: vX.X.X"

4. **OS Version Tests:**
   - On macOS → Shows ProductVersion (15.7.2 format)
   - On Linux → Shows kernel version
   - On Windows → Shows kernel version

## Documentation Updates

### REQUIREMENTS.md Changes Needed

1. Replace all "npm install" references with "bun install"
2. Update "Node.js >= 14.0.0" to "Bun >= 1.0.0"
3. Update system information to show "Bun Version" instead of "Node Version"
4. Emphasize Bun-first approach

## Additional Notes

- The project uses `#!/usr/bin/env bun` shebang correctly
- Package scripts still use `node --test` which should be changed to `bun test`
- All references to npm in documentation should be updated to bun
- Consider removing npm-specific features if they don't work with bun

## Files to Modify

1. `src/bin/cli.js` - Fix all version detection issues
2. `src/lib/args-parser.js` - No changes needed (issue is in cli.js)
3. `REQUIREMENTS.md` - Update to Bun-first approach
4. `package.json` - Update test script to use bun
5. `test/cli.test.js` - Add version detection tests
6. New: `test/version.test.js` - Comprehensive version tests

## Success Criteria

- ✅ `$ --version --` works same as `$ --version`
- ✅ Screen version detected correctly when installed
- ✅ Shows "Bun Version" instead of "Node Version"
- ✅ macOS shows ProductVersion not kernel version
- ✅ All tests pass locally
- ✅ CI tests pass
- ✅ REQUIREMENTS.md updated
- ✅ No npm references in documentation

## Implementation Status

**Status:** 🔄 In Progress (Second Iteration)

### First Iteration (PR #23 - Merged to Main)

The initial fixes were merged to `main` branch via PR #23, addressing:

- Version flag handling with trailing `--`
- Runtime detection (Bun vs Node.js)
- macOS version detection using `sw_vers`
- Basic screen detection using `2>&1`

### Second Iteration (This PR) - The Screen Detection Bug

After v0.7.1 was released, users on macOS still reported:

```
screen: not installed
```

Even though screen was installed:

```bash
$ screen -v
Screen version 4.00.03 (FAU) 23-Oct-06
```

#### Deep Root Cause Analysis

**The Problem:** The macOS bundled version of GNU Screen (4.00.03) returns a **non-zero exit code** when running `screen --version` or `screen -v`, even though it successfully outputs the version information.

**Discovery Process:**

1. Searched for known issues with GNU Screen version flag
2. Found reference to [GNU Screen v.4.8.0 release notes](https://savannah.gnu.org/forum/forum.php?forum_id=9665)
3. The release notes mention: "Make screen exit code be 0 when checking --version"

**Root Cause Confirmed:**
This was a **known bug in GNU Screen prior to version 4.8.0** where the `--version` flag would exit with a non-zero status code.

- macOS bundled version: 4.00.03 (affected by bug)
- Bug fix version: 4.8.0+
- Linux typically has newer versions via package managers

**Why Previous Fix Didn't Work:**

The previous fix used `execSync()` with `2>&1` to capture stderr:

```javascript
const result = execSync(`${toolName} ${versionFlag} 2>&1`, {
  encoding: 'utf8',
  timeout: 5000,
}).trim();
```

**Problem:** `execSync()` throws an exception when the command returns non-zero exit code, so even though the output was captured correctly, the `catch` block returned `null`.

#### The Solution

Use `spawnSync()` instead of `execSync()` to capture output **regardless of exit code**:

```javascript
function getToolVersion(toolName, versionFlag, verbose = false) {
  const isWindows = process.platform === 'win32';
  const whichCmd = isWindows ? 'where' : 'which';

  // First, check if the tool exists in PATH
  try {
    execSync(`${whichCmd} ${toolName}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Tool not found in PATH
    return null;
  }

  // Tool exists, try to get version using spawnSync
  // This captures output regardless of exit code
  const result = spawnSync(toolName, [versionFlag], {
    encoding: 'utf8',
    timeout: 5000,
    shell: false,
  });

  // Combine stdout and stderr
  const output = ((result.stdout || '') + (result.stderr || '')).trim();

  if (!output) {
    return null;
  }

  return output.split('\n')[0];
}
```

#### Additional Improvements

1. **`--verbose` flag support** - Users can now debug version detection:

   ```bash
   $ --version --verbose
   ```

   This shows detailed debugging information about tool detection.

2. **`-v` flag for screen** - Changed from `--version` to `-v` which is more universally supported.

3. **Comprehensive test coverage** - Added 14 tests for version detection scenarios.

### Changes Made (Second Iteration)

#### src/bin/cli.js

1. **Added `spawnSync` import:**

   ```javascript
   const { spawn, execSync, spawnSync } = require('child_process');
   ```

2. **Enhanced version flag handling with verbose support:**

   ```javascript
   const hasVerboseWithVersion =
     hasVersionFlag &&
     args.some((arg) => arg === '--verbose' || arg === '--debug');

   if (hasVersionFlag && isVersionOnly) {
     printVersion(hasVerboseWithVersion || config.verbose);
     process.exit(0);
   }
   ```

3. **Fixed getToolVersion to use spawnSync:**
   - First checks if tool exists using `which`/`where`
   - Uses `spawnSync` to capture output regardless of exit code
   - Combines stdout and stderr
   - Supports verbose mode for debugging

4. **Updated printVersion to accept verbose parameter:**
   - Shows `[verbose]` messages when debugging
   - Logs tool detection details

#### test/version.test.js

Added 3 new tests for verbose mode:

- `--version --verbose`
- `--version --debug`
- `START_VERBOSE=1` environment variable

### Test Results

All 84 tests passing across 4 test files:

- `test/version.test.js`: 14 tests
- `test/cli.test.js`: Passing
- `test/args-parser.test.js`: Passing
- `test/isolation.test.js`: Passing
- `test/substitution.test.js`: 22 tests

### Verified Behavior

```bash
$ --version
start-command version: 0.7.1

OS: linux
OS Version: 6.8.0-90-generic
Bun Version: 1.3.3
Architecture: x64

Isolation tools:
  screen: Screen version 4.09.01 (GNU) 20-Aug-23
  tmux: tmux 3.4
  docker: not installed
```

```bash
$ --version --verbose
start-command version: 0.7.1

OS: linux
OS Version: 6.8.0-90-generic
Bun Version: 1.3.3
Architecture: x64

Isolation tools:
[verbose] Checking isolation tools...
[verbose] screen -v: exit=0, output="Screen version 4.09.01 (GNU) 20-Aug-23"
  screen: Screen version 4.09.01 (GNU) 20-Aug-23
[verbose] tmux -V: exit=0, output="tmux 3.4"
  tmux: tmux 3.4
[verbose] docker: not found in PATH
  docker: not installed
```

## Key Learnings

1. **Exit codes matter**: Some tools return non-zero exit codes even for successful operations. Always consider using `spawnSync` when you need to capture output regardless of exit status.

2. **macOS bundled tools are often outdated**: The macOS bundled version of screen (4.00.03 from 2006) has known bugs fixed in newer versions.

3. **Testing on multiple platforms is crucial**: The bug only manifested on macOS with the bundled screen, not on Linux with modern screen versions.

4. **Verbose mode is invaluable for debugging**: Adding `--verbose` support allows users to self-diagnose issues.

## References

- [GNU Screen v.4.8.0 Release Notes](https://savannah.gnu.org/forum/forum.php?forum_id=9665) - Documents the exit code fix
- [screen Man Page - macOS](https://ss64.com/mac/screen.html) - macOS screen documentation
- [Node.js spawnSync](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options) - Alternative to execSync that doesn't throw on non-zero exit
