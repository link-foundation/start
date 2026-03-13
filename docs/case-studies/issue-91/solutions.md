# Solutions: Issue #91

## Problem Statement

`bash -i -c "nvm --version"` passed to Docker isolation was:
1. Wrapped in an outer shell (double-wrap bug)
2. The `-c` script argument `nvm --version` was split into two tokens (quote-stripping bug)

## Solutions Considered

### Option A: Pass `rawCommand` through the call chain

**Approach:** Add a `rawCommand: string[]` parameter to `runIsolated()` and `runInDocker()`.
When available, use the array directly as Docker argv.

**Pros:** Exact, no reconstruction needed.

**Cons:** Requires changing the public interface of `runIsolated()` and all callers. Larger
diff, higher risk of regression. The `rawCommand` is only available at the cli.js layer;
other callers (tests, command-builder) use string commands.

### Option B: Shell-quoting library (e.g., `shellwords`, `shell-quote`)

**Approach:** Use a proper shell tokenizer to parse the command string back into argv.

**Pros:** Handles complex quoting, escape sequences.

**Cons:** Adds a dependency. The real issue is simpler: `commandArgs.join(' ')` only loses
the boundary when a `-c` argument contains spaces. We don't need a full shell parser.
Also, the actual quoting was already stripped by the user's shell before we received argv.

### Option C: Add `-c` argument reconstruction at the point of use (CHOSEN)

**Approach:** Add two helpers to `isolation.js`:
- `isShellInvocationWithArgs(command)` — detects `bash/zsh/sh/... -c ...` commands
- `buildShellWithArgsCmdArgs(command)` — rebuilds argv: split before `-c`, join after `-c`

In `runInDocker()`, for commands that match `isShellInvocationWithArgs()`, use
`buildShellWithArgsCmdArgs()` to get the correct argv instead of wrapping in an outer shell.

**Pros:**
- Minimal, focused change — only isolation.js affected
- No interface change required
- The reconstruction logic is correct for this use case: everything after `-c` was one
  argv element in the original array (the user's shell had already processed the quotes)
- Easy to test with unit tests
- Consistent with the issue-84 fix pattern

**Cons:**
- The reconstruction (`join(' ')`) is only correct when the original `-c` argument did not
  itself contain spaces that should be preserved distinctly. In practice, `nvm --version`
  reconstructs correctly to `nvm --version`. Complex nested quoting (e.g.,
  `bash -c "echo 'a b'"`) would still have the split at `commandArgs.join(' ')`, but would
  reconstruct as `echo 'a b'` — which is what the inner bash sees and handles correctly.

## Chosen Solution: Option C

**Implementation:**

```js
// New helper: detects shell-with-c commands
function isShellInvocationWithArgs(command) {
  const parts = command.trim().split(/\s+/);
  const shells = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'csh', 'tcsh', 'dash'];
  return shells.includes(path.basename(parts[0])) && parts.includes('-c');
}

// New helper: rebuilds argv for shell-with-c commands
function buildShellWithArgsCmdArgs(command) {
  const parts = command.trim().split(/\s+/);
  const cIdx = parts.indexOf('-c');
  if (cIdx === -1) return parts;
  const before = parts.slice(0, cIdx + 1);
  const scriptArg = parts.slice(cIdx + 1).join(' ');
  return scriptArg.length > 0 ? [...before, scriptArg] : before;
}
```

**Usage in runInDocker() attached mode:**
```js
if (isBareShell) {
  // ... issue #84 fix (unchanged)
} else if (isShellInvocationWithArgs(command)) {
  attachedCmdArgs = buildShellWithArgsCmdArgs(command);  // NEW: issue #91 fix
} else {
  attachedCmdArgs = [...shellCmdArgs, '-c', command];    // unchanged for non-shell commands
}
```

## Why This Is Correct

The user's shell has already processed the outer quotes. When the user types:
```
$ --isolated docker -- bash -i -c "nvm --version"
```
Their shell passes `['bash', '-i', '-c', 'nvm --version']` to our process. The only information
we lost is that `nvm --version` was one element. Our reconstruction (`join(' ')` of everything
after `-c`) correctly restores this to `'nvm --version'`.

The key invariant: for `bash -c <script>`, everything after `-c` in the original argv is exactly
one script string. `buildShellWithArgsCmdArgs()` implements this by joining everything after the
first `-c` token with spaces — which is the exact reverse of the `join(' ')` that lost it.
