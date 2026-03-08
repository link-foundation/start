---
'start-command': patch
---

perf: skip shell detection probe when command is a bare shell invocation

When running `$ --isolated docker -- bash`, the tool previously ran a probe
container (`docker run --rm image sh -c 'command -v bash'`) to detect which
shell to use, even though the result was unused for bare shell commands.

Now `isInteractiveShellCommand(command)` is evaluated first, and
`detectShellInEnvironment` is only called when the command is not a bare shell.
This avoids up to three unnecessary container starts per invocation and eliminates
spurious failures when the probe itself fails on images with complex entrypoints.

Also caches the `isInteractiveShellCommand(command)` result in `isBareShell` to
avoid redundant calls in both attached and detached code paths.
