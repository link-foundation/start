---
'start-command': patch
---

Fix screen isolation environment not capturing command output in attached mode

When running commands with `--isolated screen` in attached mode, the command output was not being displayed (only "screen is terminating" was shown). This was because GNU Screen requires a TTY to run in attached mode, which is not available when spawning from Node.js without a terminal.

The fix implements a fallback mechanism that:

- Checks if a TTY is available before spawning screen
- If no TTY is available, uses detached mode with log capture to run the command and display its output
- Polls for session completion and reads the captured log file
- Displays the output to the user just as if it was running in attached mode

This ensures that `$ --isolated screen -- echo "hello"` now correctly displays "hello" even when running from environments without a TTY (like CI/CD pipelines, scripts, or when piping output).
