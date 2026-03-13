# Root Cause Analysis: Issue #91

## The Two Bugs

### Bug 1 — `bash -i -c "nvm --version"` interpreted as `bash -i -c nvm --version`

**Symptom:** Instead of running `nvm --version` and printing `0.40.3`, the full `nvm --help`
output was printed.

**Cause:** The bug is in how the command string reaches `runInDocker()`.

1. The user types: `$ --isolated docker --image konard/sandbox -- bash -i -c "nvm --version"`
2. The user's shell (macOS/zsh) strips the outer quotes and passes these argv tokens to
   `start-command`:
   ```
   ['bash', '-i', '-c', 'nvm --version']
   ```
   Note: `nvm --version` is a single argv element (quotes were consumed by the user's shell).

3. In `args-parser.js`, `commandArgs = ['bash', '-i', '-c', 'nvm --version']` and
   `command = commandArgs.join(' ')` produces `bash -i -c nvm --version`.
   **The multi-word argument is now indistinguishable from separate words.**

4. In `runInDocker()` (isolation.js), `isInteractiveShellCommand(command)` returns `false`
   because the command contains `-c`. So the code falls into the else-branch:
   ```js
   attachedCmdArgs = [...shellCmdArgs, '-c', command];
   // = ['/bin/bash', '-i', '-c', 'bash -i -c nvm --version']
   ```

5. Docker executes: `docker run -it --rm ... image /bin/bash -i -c "bash -i -c nvm --version"`

6. The outer `/bin/bash -i -c` receives the script `bash -i -c nvm --version` and executes it.
   The inner bash processes: `bash -i -c nvm --version` — here `nvm` is the `-c` script
   (a one-word command), and `--version` becomes `$0` (argv[0] of the child shell).
   `nvm` with `$0=--version` prints the full help text, not just the version.

### Bug 2 — sudo advisory message printed twice

**Symptom:** The message `"To run a command as administrator (user "root"), use sudo <command>"`
appeared twice in the output.

**Cause:** The double-wrapping from Bug 1 created two nested bash shells:
- Outer `/bin/bash -i` sources `.bashrc` → prints the sudo advisory (first occurrence)
- Inner `bash -i` (from the script arg) also sources `.bashrc` → prints it again (second occurrence)

## Why Issue #84's Fix Did Not Cover This

Issue #84 added `isInteractiveShellCommand()` to detect **bare** shell invocations (no `-c`):
```js
function isInteractiveShellCommand(command) {
  const parts = command.trim().split(/\s+/);
  const shells = ['bash', 'zsh', 'sh', ...];
  return shells.includes(path.basename(parts[0])) && !parts.includes('-c');
}
```

This correctly handles `bash`, `zsh`, `bash -i`, `bash --norc`, etc. But `bash -i -c "nvm --version"`
contains `-c`, so `isInteractiveShellCommand()` returns `false`. The command was therefore
treated the same as a non-shell command like `nvm --version`, which gets wrapped in an outer
shell via `-c`. This was incorrect.

## The Information Loss Problem

The root information loss is: `commandArgs.join(' ')` in args-parser.js collapses the argv
array into a string, losing the boundary between `nvm` and `--version`. The string
`bash -i -c nvm --version` is ambiguous: is it `bash -i -c "nvm --version"` or
`bash -i -c "nvm" "--version"`?

For the `-c` flag, the correct interpretation is: everything after `-c` in the original argv
was one element, so when reconstructed from the flattened string, everything after the `-c`
token must be re-joined as one argument.

The `rawCommand` array from args-parser.js has the correct structure, but it is not passed
through to `runInDocker()`. Instead of changing the interface (which would affect all callers),
the fix reconstructs the correct argv at the point of use.
