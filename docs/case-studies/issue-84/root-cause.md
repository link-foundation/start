# Root Cause Analysis - Issue #84

## Primary Root Cause: Unconditional Shell Wrapping

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

The code **always** appends `<shell> [-i] -c <command>` to the docker arguments. When the user's
command is `bash`, this becomes `bash -i -c bash`.

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

The `.bashrc` error in `konard/sandbox:1.3.14` is a separate bug in that Docker image. However,
it would not surface twice — and would not surface at all in normal operation — if `start-command`
did not wrap `bash` inside `bash -i -c bash`.

When a user runs `docker run -it konard/sandbox:1.3.14 bash` directly (without `start-command`):
- Docker runs `bash` as the container process
- Bash starts interactively, sources `.bashrc` **once**
- If `.bashrc` has an error, user sees it once and continues

With `start-command` the wrapping doubles the sourcing.

## Secondary Root Cause: No Detection of Shell-as-Command

The CLI does not detect when the user's command **is itself a shell binary** (bash, zsh, sh, fish,
etc.). A simple check like:

```javascript
const KNOWN_SHELLS = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'csh', 'tcsh', 'dash'];
const commandName = command.trim().split(/\s+/)[0];
const isShellCommand = KNOWN_SHELLS.includes(path.basename(commandName));
```

...is absent. Without this check, the code always wraps the command in another shell.

## Tertiary Root Cause: Design Tension Between "Convenience" and "Transparency"

The tool wraps commands in a shell for convenience: users can pass complex commands with pipes,
redirects, and shell syntax. But this design creates a conflict when the user's command is itself
a shell:

- **With wrapping:** `bash -i -c bash` — nested, interactive, sources .bashrc twice, unexpected behavior
- **Without wrapping:** `bash` — direct, single process, sources .bashrc once, expected behavior

## Same-Shell Detection in `runDirect`

In `runDirect` (the non-isolation code path, `js/src/bin/cli.js`), the code does:

```javascript
const shell = isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
const shellArgs = isWindows ? ['-Command', cmd] : ['-c', cmd];
```

Here `cmd = "bash"` becomes `shellArgs = ['-c', 'bash']` and the host shell (e.g., `/bin/zsh`)
runs `zsh -c bash`. This is less harmful (different shells) but still adds an unnecessary
wrapper. The same detection logic should apply there.

## The SSH Path Has the Same Issue

In `runInSsh` (`js/src/lib/isolation.js`), attached mode:

```javascript
const remoteCommand = `nohup ${shellInvocation} -c ${JSON.stringify(command)} > ...`;
```

If `command = "bash"`, this becomes: `nohup bash -i -c bash > ...` on the remote host.

## Screen and tmux Paths Have the Same Issue

In `runInScreen` and `runInTmux`, the command is passed to the screen/tmux session inside a
shell invocation like `<shell> -c '<command>'`. If `command = "bash"`, this becomes `bash -c bash`.
