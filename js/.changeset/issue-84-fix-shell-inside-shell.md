---
'start-command': patch
---

fix: avoid running shell inside shell when command is a bare shell invocation

When running `$ --isolated docker --image <image> -- bash`, the tool was
wrapping the bare `bash` command inside `bash -i -c bash`, causing `.bashrc`
to be sourced twice and printing errors twice. Same issue affected `zsh`, `sh`,
and other shells.

Added `isInteractiveShellCommand()` helper that detects when the user's command
is a bare interactive shell invocation (e.g. `bash`, `/bin/zsh`, `bash -l`).
When detected, the command is passed directly to the isolation environment
instead of being wrapped in another shell. Applies to Docker (attached and
detached), SSH (attached and detached), and Screen (attached and detached).
