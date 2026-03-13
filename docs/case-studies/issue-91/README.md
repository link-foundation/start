# Case Study: Issue #91 — `bash -i -c "nvm --version"` mis-interpreted and double-wrapped

## Summary

When the user runs a command like:

```
$ --isolated docker --image konard/sandbox -- bash -i -c "nvm --version"
```

two bugs occurred:

**Bug 1 — Quote stripping / wrong interpretation:**
The command was displayed and executed as `bash -i -c nvm --version` — i.e., `nvm` was the
script argument to `-c`, and `--version` became `$0` (the shell's positional arg), not part
of the script. The full `nvm --version` help text was printed instead of just the version number.

**Bug 2 — Executed inside bash (double-wrapping):**
The sudo advisory message `"To run a command as administrator (user "root"), use sudo <command>"`
was printed **twice** — once per nested bash invocation.

## Fix (v0.24.6 / PR #92)

Added two helpers to `isolation.js`:

- `isShellInvocationWithArgs(command)` — detects commands that start with a shell binary
  AND include `-c` (e.g., `bash -i -c nvm --version`).
- `buildShellWithArgsCmdArgs(command)` — reconstructs the correct argv array from such
  commands, treating everything after `-c` as a single argument.

In both attached and detached Docker mode, commands detected by `isShellInvocationWithArgs()`
are now passed directly to `docker run` as argv, without any outer shell wrapping.

Before fix:
```
docker run -it --rm ... image /bin/bash -i -c "bash -i -c nvm --version"
```

After fix:
```
docker run -it --rm ... image bash -i -c "nvm --version"
```

## See Also

- [root-cause.md](root-cause.md) — Detailed root cause analysis
- [timeline.md](timeline.md) — Sequence of events
- [solutions.md](solutions.md) — Solutions considered and chosen
- Related: [Case Study issue-84](../issue-84/README.md) — "We should not run bash inside bash"
