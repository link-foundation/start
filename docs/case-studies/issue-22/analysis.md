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
