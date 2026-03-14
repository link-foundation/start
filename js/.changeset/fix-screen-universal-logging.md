---
'start-command': minor
---

fix: use screenrc-based logging for all screen versions (issue #96)

The previous fix (v0.24.9) used `-L -Logfile` for screen >= 4.5.1 and tee fallback
for older versions. The tee fallback failed on macOS with screen 4.00.03 because
tee's write buffers weren't flushed before the session ended.

The new approach uses screenrc directives (`logfile`, `logfile flush 0`, `deflog on`)
that work on ALL screen versions, eliminating both the version-dependent branching
and the unreliable tee fallback entirely.

Additional improvements:

- **Exit code capture**: Commands now report their actual exit code via a sidecar
  file, instead of always reporting 0.
- **Enhanced retry logic**: 3 retries with increasing delays (50/100/200ms) instead
  of a single 50ms retry.
- **Better debug output**: Screen isolation debug messages respond to both
  `START_DEBUG` and `START_VERBOSE` environment variables.
- **New tests**: Exit code capture, stderr capture, and multi-line output verification
  in both JavaScript and Rust.

Fixes #96
