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

## Post-Fix Regression (2026-03-08)

After releasing v0.24.1, the user reported a new failure:

```
$ --isolated docker --image konard/sandbox:latest -- bash
exit 1, duration 0.412s
```

The command exits immediately with code 1 instead of starting an interactive session.

**Root cause analysis:**
1. The `konard/sandbox:1.3.14` tag no longer exists on Docker Hub. If the image is not locally
   cached, `dockerPullImage` fails fast with exit 1 — explaining the short 0.3s duration.
2. For newer `konard/sandbox` images, if `/home/sandbox/.bashrc` causes bash to exit on startup
   (rather than just printing an error and continuing), running `bash` directly fails. This is
   a bug in the container image, not in `start-command`.

**Workaround for broken `.bashrc`:** Pass `bash --norc` to skip startup file sourcing:

```
$ --isolated docker --image konard/sandbox:latest -- bash --norc
```

The `isInteractiveShellCommand('bash --norc')` check returns `true` and passes
`['bash', '--norc']` directly to docker — the fix handles this correctly.

**Upstream fix:** The `.bashrc` bug in `konard/sandbox:1.3.14` was reported as
[konard/sandbox#1](https://github.com/konard/sandbox/issues/1). Users should pull the latest
image to get the fix: `docker pull konard/sandbox:latest`

## Documents

- [Timeline](./timeline.md) - Sequence of events reconstruction
- [Root Cause Analysis](./root-cause.md) - Deep analysis of root causes
- [Solutions](./solutions.md) - Proposed solutions and recommendations

## Related

- Issue: https://github.com/link-foundation/start/issues/84
- PR #85 (fix): https://github.com/link-foundation/start/pull/85
- PR #86 (this analysis): https://github.com/link-foundation/start/pull/86
- Upstream image bug: https://github.com/konard/sandbox/issues/1
