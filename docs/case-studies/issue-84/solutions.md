# Proposed Solutions - Issue #84

## Overview

The core problem is: when the user's command is a shell binary (`bash`, `zsh`, `sh`, etc.),
`start-command` wraps it in another shell invocation (`<shell> -i -c <user-command>`), creating
a nested shell.

Three levels of fix are possible, from minimal to comprehensive.

---

## Solution 1: Detect Shell-as-Command and Pass Directly (Recommended)

### Approach

Before constructing the docker/ssh/screen/tmux arguments, detect if the user's command is a
known shell and, if so, skip the `-c <command>` wrapping.

```javascript
// In isolation.js

const KNOWN_SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'ksh', 'csh', 'tcsh', 'dash']);

/**
 * Returns true if the given command is a bare shell invocation
 * (i.e., the user wants an interactive shell, not a command run inside a shell).
 * Examples that match: "bash", "zsh", "/bin/bash", "bash -l"
 * Examples that do NOT match: "bash -c 'echo hi'", "npm test", "ls -la"
 */
function isInteractiveShellCommand(command) {
  const parts = command.trim().split(/\s+/);
  const name = path.basename(parts[0]);
  if (!KNOWN_SHELLS.has(name)) {
    return false;
  }
  // If -c is present, the user is running a command inside the shell — keep the wrapper
  if (parts.includes('-c')) {
    return false;
  }
  return true;
}
```

### Docker Attached Mode (Primary Fix)

```javascript
// Current code:
const shellCmdArgs = shellInteractiveFlag
  ? [shellToUse, shellInteractiveFlag]
  : [shellToUse];
dockerArgs.push(options.image, ...shellCmdArgs, '-c', command);

// Fixed code:
if (isInteractiveShellCommand(command)) {
  // Pass the shell command directly as the container entrypoint — no wrapping
  const cmdParts = command.trim().split(/\s+/);
  dockerArgs.push(options.image, ...cmdParts);
} else {
  const shellCmdArgs = shellInteractiveFlag
    ? [shellToUse, shellInteractiveFlag]
    : [shellToUse];
  dockerArgs.push(options.image, ...shellCmdArgs, '-c', command);
}
```

This produces `docker run -it --rm --name <name> <image> bash` instead of
`docker run -it --rm --name <name> <image> bash -i -c bash`.

### Docker Detached Mode Fix

```javascript
// Current:
const effectiveCommand = options.keepAlive
  ? `${command}; exec ${shellToUse}`
  : command;
// ...
dockerArgs.push(options.image, ...shellArgs, '-c', effectiveCommand);

// Fixed:
if (isInteractiveShellCommand(command)) {
  const cmdParts = command.trim().split(/\s+/);
  dockerArgs.push(options.image, ...cmdParts);
} else {
  const effectiveCommand = options.keepAlive
    ? `${command}; exec ${shellToUse}`
    : command;
  dockerArgs.push(options.image, ...shellArgs, '-c', effectiveCommand);
}
```

### SSH Attached Mode Fix

```javascript
// Current:
const sshArgs = [endpoint, shellToUse, ...extraFlags, '-c', command];

// Fixed:
const sshArgs = isInteractiveShellCommand(command)
  ? [endpoint, ...command.trim().split(/\s+/)]
  : [endpoint, shellToUse, ...extraFlags, '-c', command];
```

### screen / tmux Fix

In `runInScreen` and `runInTmux`, the command is passed as `<shell> -c '<command>'`. The same
detection should be applied:

```javascript
// Current:
const wrappedCommand = `${shell} ${shellArg} '${escapedCommand}'`;

// Fixed:
const wrappedCommand = isInteractiveShellCommand(command)
  ? command
  : `${shell} ${shellArg} '${escapedCommand}'`;
```

### `runDirect` Fix (cli.js)

```javascript
// Current:
const shellArgs = isWindows ? ['-Command', cmd] : ['-c', cmd];

// Fixed:
const shellArgs = isWindows
  ? ['-Command', cmd]
  : isInteractiveShellCommand(cmd)
    ? []   // exec the shell directly without -c
    : ['-c', cmd];
```

Note: for `runDirect`, when `shellArgs` is empty the spawn call should use the command directly
rather than going through the host shell.

---

## Solution 2: Expose `--no-shell-wrap` Flag

### Approach

Add a `--no-shell-wrap` (or `--direct`) flag that tells `start-command` to pass the command
directly to the isolation backend without wrapping it in a shell.

```bash
$ --isolated docker --image konard/sandbox:1.3.14 --no-shell-wrap -- bash
# Produces: docker run -it --rm --name <name> <image> bash
```

This is a good escape hatch for power users and for exotic commands where auto-detection might
fail, but it puts the burden on the user to know when to use it.

---

## Solution 3: Auto-Detect Based on `command -v`

### Approach

Before running the user's command, check whether the command name is an executable that is
itself a shell:

```javascript
function isShellExecutable(command, environment, options) {
  const cmdName = command.trim().split(/\s+/)[0];
  // Check if it is in the known shells list
  if (KNOWN_SHELLS.has(path.basename(cmdName))) {
    return true;
  }
  // Could also check: docker run --rm <image> sh -c 'readlink -f $(command -v <cmd>)'
  // and compare the result to known shell paths
  return false;
}
```

This is more robust for edge cases like `/usr/local/bin/bash` or a shell under a non-standard name,
but adds an extra `docker run` call before execution, impacting startup time.

---

## Recommended Approach

Implement **Solution 1** (static detection of known shell names) as the primary fix.
Add **Solution 2** (`--no-shell-wrap`) as an escape hatch for advanced users.

The `isInteractiveShellCommand` helper should be placed in `isolation.js` and also exported
so `cli.js` (for `runDirect`) can reuse it.

---

## Related Existing Tools and Libraries

### How Docker Handles This Natively

`docker exec -it <container> bash` and `docker run -it <image> bash` both pass the shell
directly — no wrapping. This is the expected pattern.

### How `execa` Handles Shell Detection

The popular Node.js library [execa](https://github.com/sindresorhus/execa) provides a
`execaCommand` that takes a command string and handles shell detection. It does not auto-detect
shell-as-command, but it provides `shell: false` mode (direct exec) vs `shell: true` (wrapped).

### How `shelljs` Handles This

[shelljs](https://github.com/shelljs/shelljs) always runs through a shell (`/bin/sh -c`).
It does not handle the shell-as-command case.

### POSIX `exec` Replacement

A correct fix for the `bash` case is: when the last isolation level resolves to running a bare
shell, use the shell's own `exec` builtin to replace the outer shell process entirely:

```bash
# Instead of:
bash -i -c bash
# Use:
bash -i -c 'exec bash'
```

However, this still sources `.bashrc` twice (once for the outer `-i` bash, once for the `exec`'d
bash). The cleanest solution remains passing `bash` directly without any `-c` wrapper.

---

## Impact on `.bashrc` Bug in `konard/sandbox:1.3.14`

The `.bashrc` syntax error at line 167 of `konard/sandbox:1.3.14` is a separate issue in that
Docker image. After fixing `start-command`, the error would still appear once (since bash sources
`.bashrc` on startup), but it would no longer appear twice.

We should report this separately to the maintainer of `konard/sandbox`.
