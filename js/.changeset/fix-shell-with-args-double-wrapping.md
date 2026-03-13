---
"start-command": patch
---

fix: pass `bash -c "..."` style commands directly to Docker without double-wrapping (issue #91)

When a command like `bash -i -c "nvm --version"` was passed to Docker isolation,
it was incorrectly wrapped in an outer shell: `bash -i -c "bash -i -c nvm --version"`.
This caused two bugs: (1) the quoted argument `"nvm --version"` was split by the outer
shell, so `--version` became `$0` instead of part of the script; (2) the sudo advisory
message printed twice due to two nested bash invocations.

The fix adds `isShellInvocationWithArgs()` to detect commands that start with a shell
binary and include `-c`, and `buildShellWithArgsCmdArgs()` to reconstruct the correct
argv array. Such commands are now passed directly to Docker's exec, just like bare shell
invocations (issue #84), without any additional wrapping.
