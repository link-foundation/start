---
'start-command': patch
---

Stop `--status` from fabricating a detached session exit code out of the command's own output: the terminal exit code is now read from the anchored three-line footer `start` writes (separator / `Finished:` / `Exit Code:`) in the tail of the log only, and Docker's own `.State.ExitCode` takes precedence over the log text.
