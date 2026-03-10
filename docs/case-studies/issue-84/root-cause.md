# Root Cause Analysis - Issue #84

## Primary Root Cause (Phase 1): Unconditional Shell Wrapping

### Location in Code

`js/src/lib/isolation.js`, `runInDocker()` function, attached mode branch (around line 844):

```javascript
// Attached mode: docker run -it --rm --name <name> [--user <user>] <image> <shell> -c '<cmd>'
const dockerArgs = ['run', '-it', '--rm', '--name', containerName];
// ...
const shellCmdArgs = shellInteractiveFlag
  ? [shellToUse, shellInteractiveFlag]
  : [shellToUse];
dockerArgs.push(options.image, ...shellCmdArgs, '-c', command);
```

The code **always** appended `<shell> [-i] -c <command>` to the docker arguments. When the user's
command is `bash`, this became `bash -i -c bash`.

### Why Shell Wrapping Exists

The shell wrapper (`<shell> -c <command>`) exists because:

1. `docker run <image> bash` works for interactive shells, but
2. `docker run <image> npm test` does not work directly — npm is not the container entrypoint
3. The wrapper ensures any shell command (`npm test`, `ls -la`, shell pipelines like `cat foo | grep bar`) works inside the container

### Why `-i` (Interactive Flag) Is Added

`getShellInteractiveFlag(shellPath)` returns `"-i"` for `bash` and `zsh`. This is intended to
source `.bashrc` / `.zshrc` so the user's environment (PATH, aliases, etc.) is available inside
the container. However:

- `bash -i` sources `.bashrc`
- If `.bashrc` has a syntax error, the error is shown when the outer bash starts
- The inner `bash` (from `-c bash`) sources `.bashrc` again, showing the error a second time

### Why the Error Appears Twice

```
bash: /home/sandbox/.bashrc: line 167: syntax error: unexpected end of file
(first message)
bash: /home/sandbox/.bashrc: line 167: syntax error: unexpected end of file
(second message)
```

1. First occurrence: Outer `bash -i` sources `.bashrc` before running `-c bash`
2. Second occurrence: Inner `bash` (started by `-c bash`) is also interactive because stdin is
   a TTY (`-it` flag to docker), so it also sources `.bashrc`

### The `.bashrc` Syntax Error Is a Symptom, Not the Root Cause

The `.bashrc` error in `konard/sandbox:1.3.14` was visible in Phase 1 output. **However**, this
error does NOT cause bash to exit. The image works correctly: running `docker run -it konard/sandbox:1.3.14 bash`
gives a functional shell. The error is a warning that bash continues past. The root cause of the
double error was unconditional shell wrapping by `start-command`.

### Fix Applied (v0.24.1 PR #85)

`isInteractiveShellCommand()` was added to detect bare shell invocations and pass them directly
to docker without wrapping. This eliminated the shell-inside-shell problem.

---

## Secondary Root Cause (Phase 2): Missing `-i` Flag After v0.24.1 Fix

### The Post-Fix Regression

After v0.24.1, the command became:
```
docker run -it ... image bash
```

This is the correct form to avoid shell-inside-shell. However, the fix inadvertently removed the
explicit `-i` flag that had been present in the original (buggy) command.

### Why `-i` Matters for Bare Shell Invocations

**Without explicit `-i`**, bash determines whether to enter interactive mode through TTY detection:
- It checks if `stdin` is a terminal using `isatty(0)`
- On Linux, direct `docker run -it` typically sets up a working PTY
- On macOS with Docker Desktop, the process chain is longer:
  ```
  User's terminal → macOS kernel → Docker Desktop VM → QEMU/hypervisor → container → bash
  ```
- Through this chain, TTY propagation via `stdio: 'inherit'` in Node.js `spawn()` may not
  reliably signal to bash that it is running interactively

**With explicit `-i`**, bash is forced into interactive mode unconditionally, bypassing the
unreliable TTY detection.

### Comparison of Behavior

```
v0.24.0: docker run -it ... image /bin/bash -i -c bash
  → Outer bash: explicit -i → interactive → sources .bashrc (error shown) → runs inner bash
  → Inner bash: TTY from outer bash → interactive → sources .bashrc again (error shown twice)
  → Result: user gets shell, but with two error messages and nested shells (WRONG behavior, WORKS)

v0.24.1: docker run -it ... image bash
  → No explicit -i → relies on TTY detection
  → On macOS with Docker Desktop: TTY detection unreliable → bash may not be interactive
  → Non-interactive bash: reads stdin, gets EOF → exits with code 1
  → Result: 0.3-0.4s failure, user gets no shell (CORRECT intent, BROKEN in practice)

Fixed:   docker run -it ... image bash -i
  → Explicit -i → bash always enters interactive mode regardless of TTY detection
  → Sources .bashrc once, user gets shell
  → Result: works correctly
```

### Fix Applied (PR #87)

Bare shell commands now receive `-i` explicitly in docker attached mode. The fix is in
`runInDocker()` attached mode in `js/src/lib/isolation.js`:

```javascript
// Bare shell: pass directly with -i (avoids bash-inside-bash; -i ensures interactive).
let attachedCmdArgs;
if (isBareShell) {
  const parts = command.trim().split(/\s+/);
  const bareFlag = getShellInteractiveFlag(parts[0]);
  attachedCmdArgs =
    bareFlag && !parts.includes(bareFlag)
      ? [parts[0], bareFlag, ...parts.slice(1)]
      : parts;
} else {
  attachedCmdArgs = [...shellCmdArgs, '-c', command];
}
```

Results:
- `bash` → `['bash', '-i']`
- `bash --norc` → `['bash', '-i', '--norc']`
- `bash -i` → `['bash', '-i']` (no duplication)
- `zsh` → `['zsh', '-i']`
- `sh` → `['sh']` (sh has no `-i` convention)

---

## Tertiary Root Cause: Design Tension Between "Convenience" and "Transparency"

The tool wraps commands in a shell for convenience: users can pass complex commands with pipes,
redirects, and shell syntax. But this design creates a conflict when the user's command is itself
a shell:

- **With wrapping:** `bash -i -c bash` — nested, interactive, sources .bashrc twice, unexpected behavior
- **Without wrapping:** `bash -i` — direct, single process, sources .bashrc once, expected behavior

The `isInteractiveShellCommand()` detection function resolves this tension by routing bare shell
invocations through a different code path.

## Same-Shell Detection in `runDirect`

In `runDirect` (the non-isolation code path, `js/src/bin/cli.js`), the code does:

```javascript
const shell = isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
const shellArgs = isWindows ? ['-Command', cmd] : ['-c', cmd];
```

Here `cmd = "bash"` becomes `shellArgs = ['-c', 'bash']` and the host shell (e.g., `/bin/zsh`)
runs `zsh -c bash`. This is less harmful (different shells) but still adds an unnecessary
wrapper. The same detection logic could apply there.

## The SSH Path Has the Same Issue

In `runInSsh` (`js/src/lib/isolation.js`), attached mode:

```javascript
const remoteCommand = `nohup ${shellInvocation} -c ${JSON.stringify(command)} > ...`;
```

If `command = "bash"`, this becomes: `nohup bash -i -c bash > ...` on the remote host.

## Screen and tmux Paths Have the Same Issue

In `runInScreen` and `runInTmux`, the command is passed to the screen/tmux session inside a
shell invocation like `<shell> -c '<command>'`. If `command = "bash"`, this becomes `bash -c bash`.

The `isInteractiveShellCommand()` check is applied in these paths too, so they benefit from the
same fix even though the `-i` injection only applies in docker attached mode.
