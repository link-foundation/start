---
'start-command': patch
---

fix: capture output from quick-completing commands in screen isolation (issue #96)

When running a short-lived command like `agent --version` through screen isolation:

```
$ --isolated screen -- agent --version
```

the version output was silently lost — the command exited cleanly (exit code 0)
but no output was displayed.

**Root cause:** GNU Screen's internal log buffer flushes every 10 seconds by default
(`log_flush = 10`). For commands that complete faster than this, the buffer may not
be flushed to the log file before the screen session terminates.

**Fix:** A temporary screenrc file with `logfile flush 0` is passed to screen via
the `-c` option. This forces screen to flush the log buffer after every write,
eliminating the 10-second flush delay for quick-completing commands.

A retry mechanism is also added for the tee fallback path (older screen < 4.5.1)
to handle the TOCTOU race where the log file appears empty when first read
immediately after session completion.

Both JavaScript (`isolation.js`) and Rust (`isolation.rs`) implementations are fixed
with equivalent test coverage added.
