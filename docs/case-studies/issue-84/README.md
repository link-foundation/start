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

## Documents

- [Timeline](./timeline.md) - Sequence of events reconstruction
- [Root Cause Analysis](./root-cause.md) - Deep analysis of root causes
- [Solutions](./solutions.md) - Proposed solutions and recommendations

## Related

- Issue: https://github.com/link-foundation/start/issues/84
- PR: https://github.com/link-foundation/start/pull/85
