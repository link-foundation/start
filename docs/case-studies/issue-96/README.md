# Case Study: Issue #96 — `agent --version` output missing in screen isolation

## Summary

When running a quick-completing command (like `agent --version`) through screen isolation:

```
$ --isolated screen -- agent --version
```

the command executes successfully (exit code 0) but the output is **not displayed** — the
version string `0.13.2` is silently swallowed.

## Reproduction

```
$ --isolated screen -- agent --version
│ session   1d4a5afb-00f3-40cb-b506-0edde9288b77
│ isolation screen
│ mode      attached
│ screen    screen-1773491715194-1ppv87
│
$ agent --version


✓
│ exit      0
│ duration  0.391s
```

The expected output `0.13.2` is missing between `$ agent --version` and the `✓` marker.

## Environment

- macOS with screen 4.00.03 (bundled with macOS, does not support `-Logfile` option)
- `agent` installed via `bun install -g start-command` (added to `~/.bun/bin/`)
- zsh 5.9 as default shell

## Fix History

### v0.24.9 / PR #97 (partial fix)

Added `logfile flush 0` screenrc for the native logging path (screen ≥ 4.5.1) and
a 50ms retry for the tee fallback (screen < 4.5.1). This fixed the issue on Linux
but **did not fix macOS** because the tee fallback had inherent reliability issues.

### v0.25.0 / PR #98 (complete fix)

Replaced the entire version-dependent logging approach with a **unified
screenrc-based strategy** that works on ALL screen versions:

```
logfile /path/to/output.log    # custom log file path
logfile flush 0                # immediate buffer flush
deflog on                      # enable logging for all windows
```

This eliminates both the native `-L -Logfile` path and the tee fallback,
using only screenrc directives available since early screen versions.

Additional improvements:
1. **Exit code capture** — real exit code from command ($? via sidecar file)
2. **Enhanced retry logic** — 3 retries with increasing delays (50/100/200ms)
3. **Debug output** — responds to both `START_DEBUG` and `START_VERBOSE`
4. **New tests** — exit code capture, stderr capture, multi-line verification

## See Also

- [root-cause.md](root-cause.md) — Detailed root cause analysis
- [timeline.md](timeline.md) — Sequence of events
- [solutions.md](solutions.md) — Solutions considered and chosen
