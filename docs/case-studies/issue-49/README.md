# Case Study: CI/CD Failures in GitHub Actions Workflow

## Issue Reference
- **Issue**: [#49 - Fix all CI/CD errors and warnings](https://github.com/link-foundation/start/issues/49)
- **CI Run**: [#20684540679](https://github.com/link-foundation/start/actions/runs/20684540679)
- **Date**: January 3, 2026
- **Resolution PR**: [#50](https://github.com/link-foundation/start/pull/50)

## Executive Summary

The CI/CD pipeline experienced multiple failures across different jobs. This case study analyzes three distinct failure categories found in run #20684540679 and documents the implemented fixes:

1. **Release Job Failure** - The version-and-commit script failed due to a working directory issue (FIXED)
2. **Windows Docker Tests** - Docker tests fail on Windows because Linux images cannot run in Windows containers mode (FIXED)
3. **Windows CLI Test** - CLI test timeout causing null exit status on Windows (FIXED)

## Timeline of Events

| Timestamp (UTC) | Event | Status |
|-----------------|-------|--------|
| 2026-01-03T23:39:02Z | CI/CD workflow triggered by push to main | Started |
| 2026-01-03T23:39:09Z | Detect Changes job completed | ✓ Success |
| 2026-01-03T23:39:10Z | Lint and Format Check job started | Running |
| 2026-01-03T23:39:18Z | Test (Bun on ubuntu-latest) started | Running |
| 2026-01-03T23:39:21Z | Lint and Format Check job completed | ✓ Success |
| 2026-01-03T23:39:30Z | Test (Bun on windows-latest) - Docker tests failing | ⚠ Warning |
| 2026-01-03T23:39:35Z | Test (Bun on windows-latest) - CLI test timeout | ✗ Failed |
| 2026-01-03T23:39:53Z | Test (Bun on windows-latest) completed | ✗ Failed |
| 2026-01-03T23:40:11Z | Release job started | Running |
| 2026-01-03T23:40:23Z | Release - Check for changesets | Found 1 changeset |
| 2026-01-03T23:40:25Z | Release - Version packages step failed | ✗ Failed |
| 2026-01-03T23:40:26Z | Release job failed | ✗ Failed |

## Root Cause Analysis

### Issue 1: Release Job Failure - Working Directory Mismatch

**Symptom:**
```
Error: ENOENT: no such file or directory, open './package.json'
```

**Analysis:**
The `version-and-commit.mjs` script is invoked with `--working-dir js` argument:
```yaml
run: node scripts/version-and-commit.mjs --mode changeset --working-dir js
```

However, the script internally tries to read `./package.json` from the current working directory (repository root), not from the specified `js/` directory. The script parses `--working-dir` but never actually uses it to change the working directory or adjust the path for package.json reading.

**Root Cause:**
Line 134 in `scripts/version-and-commit.mjs`:
```javascript
return JSON.parse(readFileSync('./package.json', 'utf8')).version;
```

The script reads from `./package.json` but is executed from the repository root. The package.json is actually at `js/package.json`.

---

### Issue 2: Windows Docker Tests - Architecture Mismatch

**Symptom:**
```
docker: no matching manifest for windows/amd64 10.0.26100 in the manifest list entries.
```

Tests failing at:
- `js/test/isolation.test.js:475` - `false !== true`
- `js/test/isolation.test.js:503` - `false !== true`
- `js/test/isolation-cleanup.test.js:270` - `false !== true`
- `js/test/isolation-cleanup.test.js:343` - `false !== true`

**Analysis:**
The tests attempt to run `alpine:latest` Docker images on Windows. Alpine is a Linux-only image that doesn't support Windows containers. When Docker is running in Windows containers mode (default on Windows GitHub runners), it cannot pull or run Linux images.

The current `isDockerRunning()` check only verifies if Docker daemon is running:
```javascript
function isDockerRunning() {
  if (!isCommandAvailable('docker')) {
    return false;
  }
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
```

This check passes on Windows because Docker is installed and running, but it doesn't verify whether Linux containers are supported.

**Root Cause:**
The `isDockerRunning()` function doesn't check if the Docker daemon can run Linux images. On Windows with Docker Desktop set to Windows containers mode, Docker is "running" but cannot pull/run Linux images like `alpine:latest`.

---

### Issue 3: Windows CLI Test - Timeout and Null Exit Status

**Symptom:**
```
AssertionError: Exit code should be 0
null !== 0
```

Test failing at `js/test/cli.test.js:32` with "killed 1 dangling process" message before failure.

**Analysis:**
The CLI test on Windows takes over 5 seconds (the test timeout limit) for the first invocation:
- `should display version with --version` [5016.00ms] - FAILED (timeout, null status)
- `should display version with -v` [3047.00ms] - PASSED
- `should show correct package version` [406.00ms] - PASSED

The first invocation seems to have a cold-start performance issue on Windows. When a process is killed due to timeout, `spawnSync` returns `null` for the exit status, which causes the assertion `assert.strictEqual(result.status, 0)` to fail.

**Root Cause:**
Cold-start performance issues on Windows CI environment. Bun runtime or the CLI itself takes longer to initialize on the first run, exceeding the 5-second timeout.

## Proposed Solutions

### Solution 1: Fix version-and-commit.mjs Working Directory

**Option A (Recommended):** Change to the working directory at the start of the script:
```javascript
// After parsing config, change to working directory
if (config.workingDir) {
  process.chdir(config.workingDir);
}
```

**Option B:** Pass the working directory to all file operations:
```javascript
const workingDir = config.workingDir || '.';
return JSON.parse(readFileSync(path.join(workingDir, 'package.json'), 'utf8')).version;
```

---

### Solution 2: Fix Docker Tests on Windows

Enhance `isDockerRunning()` to check for Linux container support:

```javascript
function isDockerRunning() {
  if (!isCommandAvailable('docker')) {
    return false;
  }
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });

    // Check if we can pull/run Linux images
    // On Windows with Windows containers mode, this will fail
    if (process.platform === 'win32') {
      try {
        // Try to verify Linux container support
        const info = execSync('docker info --format "{{.OSType}}"', {
          encoding: 'utf8',
          timeout: 5000
        }).trim();
        if (info !== 'linux') {
          return false; // Windows containers mode - can't run Linux images
        }
      } catch {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
```

---

### Solution 3: Fix CLI Test Timeout on Windows

**Option A (Recommended):** Increase test timeout for Windows:
```javascript
it('should display version with --version', { timeout: 30000 }, () => {
  const result = runCLI(['--version']);
  // ...
});
```

**Option B:** Add a warmup run before tests:
```javascript
before(() => {
  // Warmup run to handle cold-start latency
  runCLI(['--version']);
});
```

**Option C:** Check for null status gracefully:
```javascript
assert.notStrictEqual(result.status, null, 'Process should not be killed');
assert.strictEqual(result.status, 0, 'Exit code should be 0');
```

## Implemented Fixes

### Fix 1: Working Directory Support in Release Scripts

Added `--working-dir` option support to all release-related scripts:

**Files Modified:**
- `scripts/version-and-commit.mjs` - Added `--working-dir` option with `process.chdir()`
- `scripts/publish-to-npm.mjs` - Added `--working-dir` option with `process.chdir()`
- `scripts/create-manual-changeset.mjs` - Added `--working-dir` option with `process.chdir()`
- `scripts/instant-version-bump.mjs` - Added `--working-dir` option with `process.chdir()`

**Code Change Example (version-and-commit.mjs):**
```javascript
.option('working-dir', {
  type: 'string',
  default: getenv('WORKING_DIR', '.'),
  describe: 'Working directory containing package.json',
})

// Change to working directory if specified
if (workingDir && workingDir !== '.') {
  console.log(`Changing to working directory: ${workingDir}`);
  process.chdir(workingDir);
}
```

---

### Fix 2: Linux Docker Image Detection

Added `canRunLinuxDockerImages()` function to `js/src/lib/isolation.js` to properly detect if Linux containers can run on the current platform.

**Files Modified:**
- `js/src/lib/isolation.js` - Added new exported function `canRunLinuxDockerImages()`
- `js/test/isolation.test.js` - Replaced `isDockerRunning()` with `canRunLinuxDockerImages()`
- `js/test/isolation-cleanup.test.js` - Replaced `isDockerRunning()` with `canRunLinuxDockerImages()`
- `js/test/docker-autoremove.test.js` - Replaced `isDockerRunning()` with `canRunLinuxDockerImages()`

**New Function:**
```javascript
function canRunLinuxDockerImages() {
  if (!isCommandAvailable('docker')) {
    return false;
  }

  try {
    execSync('docker info', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });

    // On Windows, check if Docker is configured for Linux containers
    if (process.platform === 'win32') {
      try {
        const osType = execSync('docker info --format "{{.OSType}}"', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();

        if (osType !== 'linux') {
          return false; // Windows containers mode - can't run Linux images
        }
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
```

---

### Fix 3: CLI Test Timeout on Windows

Increased timeout for CLI operations on Windows and added better error handling for process termination.

**File Modified:** `js/test/cli.test.js`

**Changes:**
```javascript
// Timeout for CLI operations - longer on Windows due to cold-start latency
const CLI_TIMEOUT = process.platform === 'win32' ? 30000 : 10000;

function runCLI(args = []) {
  return spawnSync('bun', [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT,
    // ...
  });
}

// Better error handling for killed processes
assert.notStrictEqual(
  result.status,
  null,
  `Process should complete (was killed with signal: ${result.signal})`
);
```

## Affected Files Summary

| File | Issue | Fix Applied |
|------|-------|-------------|
| `scripts/version-and-commit.mjs` | Working directory not used | ✅ Added `--working-dir` option |
| `scripts/publish-to-npm.mjs` | Working directory not used | ✅ Added `--working-dir` option |
| `scripts/create-manual-changeset.mjs` | Working directory not used | ✅ Added `--working-dir` option |
| `scripts/instant-version-bump.mjs` | Working directory not used | ✅ Added `--working-dir` option |
| `js/src/lib/isolation.js` | Missing Linux container check | ✅ Added `canRunLinuxDockerImages()` |
| `js/test/isolation.test.js` | Docker Linux check missing | ✅ Using `canRunLinuxDockerImages()` |
| `js/test/isolation-cleanup.test.js` | Docker Linux check missing | ✅ Using `canRunLinuxDockerImages()` |
| `js/test/docker-autoremove.test.js` | Docker Linux check missing | ✅ Using `canRunLinuxDockerImages()` |
| `js/test/cli.test.js` | Timeout too short | ✅ Increased timeout for Windows |

## References

- [Docker: no matching manifest for windows/amd64 (Docker Forums)](https://forums.docker.com/t/no-matching-manifest-for-windows-amd64-10-0-17763-in-the-manifest-list-entries/132463)
- [Alpine Linux Docker - Architecture Issues](https://github.com/alpinelinux/docker-alpine/issues/426)
- [How to fix "no matching manifest" in Docker](https://www.khueapps.com/blog/article/how-to-fix-no-matching-manifest-for-linux-amd64-or-arm64-in-the-manifest-list-entries)

## CI Logs

The full CI logs have been preserved in this case study folder:
- `ci-logs/full-run-20684540679.log` - Complete CI run logs
- `ci-logs/failed-run-20684540679.log` - Failed steps log
