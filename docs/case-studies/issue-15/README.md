# Case Study: Issue #15 - Screen Isolation Not Working As Expected

## Issue Summary

**Issue URL:** https://github.com/link-foundation/start/issues/15
**Date Reported:** 2025-12-22
**Reporter:** @konard
**Status:** Investigating

### Problem Statement

The screen isolation environment does not display command output when running in attached mode. When using `$ --isolated screen -- echo "hello"`, the expected output "hello" is not shown - instead, only `[screen is terminating]` appears.

### Environment

- **Platform:** macOS (reported), Linux (reproduced)
- **Package:** start-command@0.5.1
- **Screen version:** macOS bundled 4.0.3, Linux 4.09.01

## Timeline of Events

1. User installs start-command: `bun install -g start-command`
2. Direct command execution works: `$ echo "hello"` shows "hello"
3. Docker isolation works: `$ --isolated docker --image alpine -- echo "hello"` shows "hello"
4. Screen isolation fails: `$ --isolated screen -- echo "hello"` shows only `[screen is terminating]`

## Reproduction

### Observed Behavior

```
$ echo "hello"
[2025-12-22 13:45:05.245] Starting: echo hello
hello
[2025-12-22 13:45:05.254] Finished
Exit code: 0

$ --isolated docker --image alpine -- echo "hello"
[2025-12-22 13:45:07.847] Starting: echo hello
[Isolation] Environment: docker, Mode: attached
[Isolation] Image: alpine
hello
Docker container "docker-..." exited with code 0
[2025-12-22 13:45:08.066] Finished
Exit code: 0

$ --isolated screen -- echo "hello"
[2025-12-22 13:45:11.134] Starting: echo hello
[Isolation] Environment: screen, Mode: attached
[screen is terminating]
Screen session "screen-..." exited with code 0
[2025-12-22 13:45:11.199] Finished
Exit code: 0
```

**Notice:** No "hello" output in the screen isolation case, though exit code is 0.

## Root Cause Analysis

### PRIMARY ROOT CAUSE: macOS Screen Version Incompatibility

**macOS ships with GNU Screen version 4.0.3, which does NOT support the `-Logfile` option.**

The `-Logfile` option was introduced in **GNU Screen 4.5.1** (released February 2017).

| Platform        | Screen Version | `-Logfile` Support |
| --------------- | -------------- | ------------------ |
| macOS (bundled) | 4.0.3          | **NO**             |
| Linux (CI/Test) | 4.09.01        | YES                |

The current implementation uses:

```javascript
const screenArgs = [
  '-dmS',
  sessionName,
  '-L',
  '-Logfile',
  logFile, // <-- NOT SUPPORTED on macOS bundled screen
  shell,
  shellArg,
  command,
];
```

On macOS with screen 4.0.3:

1. The `-Logfile` option is silently ignored or treated as a command argument
2. The `-L` flag alone creates a log file named `screenlog.0` in the current directory
3. The code tries to read from the wrong file path (`/tmp/screen-output-*.log`)
4. Result: No output is captured or displayed

### Secondary Root Cause: TTY Requirement

When TTY is available, the code attempts attached mode which fails:

1. **TTY Requirement**: The GNU Screen command requires a connected terminal (TTY/PTY) to run in attached mode.

2. **Node.js spawn behavior**: When spawning processes with `child_process.spawn()`, even with `stdio: 'inherit'`, Node.js does not always provide a proper pseudo-terminal (PTY) that screen requires.

3. **Error in non-TTY environments**: Running `screen -S session shell -c command` without a TTY results in:

   ```
   Must be connected to a terminal.
   ```

4. **Detached mode works**: Running `screen -dmS session shell -c command` works because it doesn't require an attached terminal.

### Experimental Evidence

Testing revealed:

- `process.stdin.isTTY` and `process.stdout.isTTY` are `undefined` when running from Node.js
- Detached mode with logging (`screen -dmS ... -L -Logfile ...`) captures output correctly **on Linux only**
- Using `script -q -c "screen ..." /dev/null` can provide a PTY but includes terminal escape codes
- On macOS with screen 4.0.3, the `-Logfile` option is unknown

### Version Check Evidence

```bash
# Linux (works)
$ screen --version
Screen version 4.09.01 (GNU) 20-Aug-23

# macOS bundled (broken)
$ screen --version
Screen version 4.00.03 (FAU) 23-Oct-06
```

### Comparison with Docker

Docker isolation works because:

1. Docker run with `-it` flags handles terminal attachment
2. Docker spawns an isolated container that manages its own pseudo-terminal
3. The command output flows through Docker's I/O handling

## Solution: Version Detection with Fallback

### Approach

1. **Detect screen version** at runtime
2. **Version >= 4.5.1**: Use `-L -Logfile` approach
3. **Version < 4.5.1**: Use output redirection (`tee`) approach within the command

### Implementation

```javascript
function getScreenVersion() {
  try {
    const output = execSync('screen --version', { encoding: 'utf8' });
    const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      return {
        major: parseInt(match[1]),
        minor: parseInt(match[2]),
        patch: parseInt(match[3]),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function supportsLogfileOption() {
  const version = getScreenVersion();
  if (!version) return false;
  // -Logfile was added in 4.5.1
  return (
    version.major > 4 ||
    (version.major === 4 && version.minor > 5) ||
    (version.major === 4 && version.minor === 5 && version.patch >= 1)
  );
}
```

For older versions, wrap command with tee:

```javascript
const wrappedCommand = `(${command}) 2>&1 | tee "${logFile}"`;
const screenArgs = ['-dmS', sessionName, shell, shellArg, wrappedCommand];
```

## Testing Strategy

1. **Unit tests**: Test version detection logic
2. **Unit tests**: Test screen version comparison
3. **Integration tests**: Test output capture for both code paths
4. **Regression tests**: Verify existing tests still pass
5. **CI tests**: Ensure output is verified in assertions (not just exit code)

## References

- [GNU Screen v.4.5.1 changelog](https://lists.gnu.org/archive/html/info-gnu/2017-02/msg00000.html) - Introduction of `-Logfile` option
- [GitHub Issue: RHEL7 screen does not know the Logfile option](https://github.com/distributed-system-analysis/pbench/issues/1558)
- [How to install GNU Screen on OS X using Homebrew](https://gist.github.com/bigeasy/2327150)
- [GNU Screen Manual](https://www.gnu.org/software/screen/manual/screen.html)
- [script command man page](https://man7.org/linux/man-pages/man1/script.1.html)

## Appendix: Test Logs

See accompanying log files:

- `test-output-1.log` - Initial reproduction
- `screen-modes-test.log` - Screen modes investigation
- `screen-attached-approaches.log` - Solution approaches testing
- `test-screen-logfile.js` - Version compatibility testing
