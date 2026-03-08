# Case Study: Issue #84 - We should not run `bash` inside `bash`

## Summary

When the user runs a command like `$ --isolated docker --image konard/sandbox:1.3.14 -- bash`,
the `start-command` CLI wraps the user-supplied command (`bash`) inside a shell invocation:

```
docker run -it --rm --name <container> bash -i -c bash
```

This runs `bash -i -c bash` inside the Docker container, which causes bash to start an
interactive sub-shell instead of giving the user a direct interactive bash session. The result
is the `~/.bashrc` is sourced with errors because the shell is interactive but not a login
shell in the expected way, producing:

```
bash: /home/sandbox/.bashrc: line 167: syntax error: unexpected end of file
```

The issue also applies to `zsh` and `sh`.

## Fix (v0.24.1 / PR #85)

Added `isInteractiveShellCommand()` to `isolation.js` that detects bare shell invocations
(e.g., `bash`, `zsh`, `/bin/bash`, `bash -l`) and passes them directly to the isolation
backend instead of wrapping them with `-i -c`.

Before fix: `docker run -it --rm ... image /bin/bash -i -c bash`
After fix:  `docker run -it --rm ... image bash`

This prevents the shell-inside-shell nesting. The fix applies to all backends: docker, ssh,
screen, and tmux.

## Optimization (v0.24.2 / PR #86)

Added a performance optimization: `detectShellInEnvironment()` is now skipped for bare shell
invocations. Previously, even for bare `bash` commands, a probe container
(`docker run --rm image sh -c 'command -v bash'`) was started to detect the available shell.
Since bare shell commands don't use the detected shell (they're passed directly), this probe
was wasteful and could itself cause failures on images with complex entrypoints.

## Post-Fix Regression (2026-03-08)

After releasing v0.24.1 and v0.24.2, the user reported continued failures:

```
$ --isolated docker --image konard/sandbox:latest -- bash
exit 1, duration 0.443s

$ --isolated docker --image konard/sandbox:1.3.14 -- bash
exit 1, duration 0.298s

$ --isolated docker --image konard/sandbox -- bash
exit 1, duration 0.299s
```

**All three image references fail** with exit 1 in 0.3-0.4 seconds.
The user notes: "The image even does not get pulled, before it just worked."

### Root Cause Analysis (Second Comment, 2026-03-08 21:05)

**Key finding**: The image IS locally cached (hence "does not get pulled"). The `dockerImageExists()`
function uses `docker image inspect` which returns immediately for cached images. Since no pull is
shown in the output, `dockerImageExists()` returned true for all three image references.

**Timeline of the 0.3-0.4 second failure:**
1. `dockerImageExists('konard/sandbox:latest')` → true (cached) → no pull shown (0-50ms)
2. `docker run -it --rm --name <container> konard/sandbox:latest bash` starts (100-300ms)
3. Bash reads `/home/sandbox/.bashrc` which exits non-zero (10-50ms)
4. Container exits with code 1 (total: 0.3-0.4s)

**Why v0.24.0 "just worked"** despite the same broken `.bashrc`:

With v0.24.0, the command was `docker run -it ... image bash -i -c bash`.
- The OUTER bash runs with `-i` flag
- When `.bashrc` has a syntax error, bash REPORTS it but does not exit non-interactively
- The outer bash then runs the INNER `bash` command, giving the user a shell
- Despite errors appearing twice, the user got a functional (if messy) shell

With v0.24.1+, the command is `docker run -it ... image bash`.
- Bash is the container entrypoint directly
- When `.bashrc` causes bash to exit with code 1 (e.g., due to `set -e` + failing command),
  bash exits immediately

**Why bash exits 1 in the new images**: The `konard/sandbox` image's `.bashrc` likely contains
`set -e` (exit-on-error) before the syntax error at line 167. With `set -e`, any command that
returns non-zero causes bash to exit immediately. When the outer bash previously ran `.bashrc`
with `-i -c bash`, the error was caught at the outer shell level. When bash is the entrypoint,
the `.bashrc` error kills the shell process itself.

**Docker Hub status (verified 2026-03-08)**:
- `konard/sandbox:1.3.14` — EXISTS on Docker Hub (not removed)
- `konard/sandbox:latest` = `konard/sandbox:1.3.16` (updated 2026-03-07)
- The `.bashrc` issue affects multiple image versions, including `1.3.16`

### Workaround for Broken `.bashrc`

Pass `bash --norc` to skip startup file sourcing:

```
$ --isolated docker --image konard/sandbox:latest -- bash --norc
```

The `isInteractiveShellCommand('bash --norc')` check returns `true` and passes
`['bash', '--norc']` directly to docker — the fix handles this correctly.

### Upstream Fix

The `.bashrc` bug in `konard/sandbox` was reported as
[konard/sandbox#1](https://github.com/konard/sandbox/issues/1). The image maintainer should:
1. Identify the `set -e` or equivalent that causes bash to exit on startup
2. Remove or reorder the problematic code to not run before `.bashrc` is fully sourced
3. Test with `docker run -it --rm konard/sandbox:latest bash`
4. Release a new image version

## Documents

- [Timeline](./timeline.md) - Sequence of events reconstruction
- [Root Cause Analysis](./root-cause.md) - Deep analysis of root causes
- [Solutions](./solutions.md) - Proposed solutions and recommendations

## Related

- Issue: https://github.com/link-foundation/start/issues/84
- PR #85 (fix): https://github.com/link-foundation/start/pull/85
- PR #86 (analysis): https://github.com/link-foundation/start/pull/86
- PR #87 (current): https://github.com/link-foundation/start/pull/87
- Upstream image bug: https://github.com/konard/sandbox/issues/1
