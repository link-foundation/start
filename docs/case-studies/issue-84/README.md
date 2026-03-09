# Case Study: Issue #84 - We should not run `bash` inside `bash`

## Summary

When the user runs a command like `$ --isolated docker --image konard/sandbox:1.3.14 -- bash`,
the `start-command` CLI wraps the user-supplied command (`bash`) inside a shell invocation:

```
docker run -it --rm --name <container> /bin/bash -i -c bash
```

This runs `bash -i -c bash` inside the Docker container — bash nested inside bash — causing
the `.bashrc` to be sourced twice and the errors to appear twice. The issue also applies to
`zsh` and `sh`.

## Fix (v0.24.1 / PR #85)

Added `isInteractiveShellCommand()` to `isolation.js` that detects bare shell invocations
(e.g., `bash`, `zsh`, `/bin/bash`, `bash -l`) and passes them directly to the isolation
backend instead of wrapping them with `-i -c`.

Before fix: `docker run -it --rm ... image /bin/bash -i -c bash`
After fix:  `docker run -it --rm ... image bash -i`

The `-i` flag is added explicitly to ensure bash reliably enters interactive mode
regardless of how the process chain propagates the TTY (see Post-Fix Regression below).

This fix applies to all backends: docker, ssh, screen, and tmux.

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

### Root Cause: Missing `-i` Flag for Bare Shell Invocations

The `konard/sandbox:1.3.14` image has a working `.bashrc` and works correctly when run
directly as `docker run -it konard/sandbox:1.3.14 bash`. The `.bashrc` error shown in
the original Phase 1 output was already there before the fix — it was shown but bash
continued running and the user got a functional shell.

The regression was introduced by the v0.24.1 fix: changing from `bash -i -c bash` to
just `bash` removed the explicit `-i` flag that had been passed to the inner shell.

**Why `-i` matters**: When `start-command` spawns `docker` via Node.js `spawn()` with
`stdio: 'inherit'`, the TTY from the user's terminal is forwarded through to the container.
However, this TTY forwarding may not always be reliable — particularly on macOS with
Docker Desktop where there are additional VM layers in the process chain. Without the
explicit `-i` flag, bash may not detect that it should be interactive, causing it to
exit immediately rather than waiting for user input.

**The fix**: Add `-i` explicitly to bare shell invocations in docker attached mode.
This guarantees interactive mode regardless of how the TTY is passed through:

```
v0.24.0: docker run -it ... image /bin/bash -i -c bash  (WRONG: bash inside bash)
v0.24.1: docker run -it ... image bash                  (WRONG: missing -i)
Fixed:   docker run -it ... image bash -i               (CORRECT: direct + interactive)
```

For images where `.bashrc` has errors that prevent bash from starting, the user can use
`bash --norc` which becomes `docker run -it ... image bash -i --norc`.

**Timeline of the 0.3-0.4 second failure:**
1. `dockerImageExists('konard/sandbox:1.3.14')` → true (cached locally) → no pull shown
2. `docker run -it --rm --name <container> konard/sandbox:1.3.14 bash` starts
3. Bash sees stdin may not be a proper TTY → starts non-interactively
4. Non-interactive bash reads stdin, gets EOF immediately → exits with code 0 or 1

**Docker Hub status (verified 2026-03-08)**:
- `konard/sandbox:1.3.14` — EXISTS on Docker Hub (active, not removed)
- `konard/sandbox:latest` = `konard/sandbox:1.3.16` (updated 2026-03-07)

### Workaround for Startup File Errors

If `.bashrc` has errors that prevent bash from starting interactively, pass `--norc`:

```
$ --isolated docker --image konard/sandbox:latest -- bash --norc
```

The `isInteractiveShellCommand('bash --norc')` check returns `true` and passes
`['bash', '-i', '--norc']` directly to docker — skipping `.bashrc` sourcing.

## Documents

- [Timeline](./timeline.md) - Sequence of events reconstruction
- [Root Cause Analysis](./root-cause.md) - Deep analysis of root causes
- [Solutions](./solutions.md) - Proposed solutions and recommendations

## Related

- Issue: https://github.com/link-foundation/start/issues/84
- PR #85 (fix): https://github.com/link-foundation/start/pull/85
- PR #86 (analysis): https://github.com/link-foundation/start/pull/86
- PR #87 (current): https://github.com/link-foundation/start/pull/87
