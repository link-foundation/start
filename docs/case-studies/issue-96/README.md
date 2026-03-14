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

## Fix (v0.24.9 / PR #97)

Two changes were made:

### 1. Add `logfile flush 0` to screen's configuration

For the **native logging path** (`-L -Logfile`, screen ≥ 4.5.1), screen uses a periodic
flush timer that fires every **10 seconds** by default. If the command completes and the
screen session terminates before this timer fires, output buffered inside screen's internal
`FILE*` buffer may not be flushed to the log file before the session ends.

The fix passes a temporary screenrc with `logfile flush 0` via screen's `-c` option. This
forces screen to flush the log after every write, eliminating the race condition.

Before fix:
```
screen -dmS <session> -L -Logfile <logfile> <shell> -c '<command>'
```

After fix:
```
screen -dmS <session> -c <screenrc> -L -Logfile <logfile> <shell> -c '<command>'
```

where `<screenrc>` contains `logfile flush 0`.

### 2. Add integration test for quick-completing commands

Added a test case specifically for the issue: `runInScreen('agent --version')` must
capture the version output correctly.

## See Also

- [root-cause.md](root-cause.md) — Detailed root cause analysis
- [timeline.md](timeline.md) — Sequence of events
- [solutions.md](solutions.md) — Solutions considered and chosen
- Related: [Case Study issue-15](../issue-15/README.md) — Original screen output capture fix
- Related: [Case Study issue-25](../issue-25/README.md) — Screen quoting fix
