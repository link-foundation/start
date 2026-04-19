# Case Study: Issue #103 - Detached Logs Were Not Recorded in Real Time

## Source Data

- Issue: https://github.com/link-foundation/start/issues/103
- Raw issue data: `issue-data.json`
- Raw issue comments: `issue-comments.json`
- Local JS reproduction before fix: `reproduction-js-before.log`
- Local JS reproduction after fix: `reproduction-js-after.log`

## Timeline

1. 2026-04-19 06:31:33 UTC: A detached `screen` execution was started for a long-running `solve ...` command.
2. 2026-04-19 06:39:25 UTC: Issue #103 was opened after `--status` reported a `logPath`, but reading that file showed only start-command metadata and wrapper completion.
3. Local reproduction before the fix matched the report: detached JS screen execution wrote a metadata-only file at `/tmp/start-command-screen-...log`, while the actual command output was not captured there.
4. Local reproduction after the fix writes the tracked log under `/tmp/start-command/logs/isolation/screen/<uuid>.log` and appends detached command output plus the command exit footer after the wrapper exits.

## Requirements

- The path reported as `logPath` must contain the actual command output while the command is still running.
- The same file must contain the full command log after completion.
- start-command temporary files should use `/tmp/start-command/` by default.
- The log path should be stable and UUID-addressable when a session/execution UUID is known, for example `/tmp/start-command/logs/isolation/screen/<uuid>.log`.
- The behavior must be implemented in both JavaScript and Rust.
- Detached isolation status should refer to the real backend session name, not a separate generated display-only name.

## Root Causes

1. JS detached screen logging did not enable GNU Screen logging at all. `runInScreen(... detached: true)` started `screen -dmS ...` and returned immediately, so no backend output writer ever touched the tracked `logPath`.
2. JS `runWithIsolation()` generated a session name for display and tracking but passed `options.session` to `runIsolated()`. When no explicit session was provided, the backend generated a second session name, so status tracking could point at the wrong session.
3. Isolation log content was buffered in memory and written at wrapper completion. In detached mode, wrapper completion is only "session started", not command completion, so the file was overwritten with metadata before the isolated command produced output.
4. Screen attached-mode capture already used a private screen log file, but that output was not the canonical status `logPath`.
5. Rust had the same detached screen shape: start the multiplexer, return immediately, and write only wrapper metadata to the tracked log.

## External Facts

- GNU Screen logging appends to an existing log file and supports setting `logfile` plus `logfile flush secs`; the default flush interval is 10 seconds. The fix uses `logfile flush 0` so screen output is visible promptly in the tracked log. Source: https://www.gnu.org/software/screen/manual/html_node/Log.html
- tmux supports `pipe-pane -o` to pipe pane output to a shell command such as `cat >> logfile`. Source: https://www.man7.org/linux/man-pages/man1/tmux.1.html

## Solution

- Default log root changed to `/tmp/start-command/logs`, with sidecar files under `/tmp/start-command/tmp`.
- `createLogPath(environment, executionId)` / `create_log_path_for_execution()` now create stable paths under:
  - `/tmp/start-command/logs/direct/<uuid>.log`
  - `/tmp/start-command/logs/isolation/<backend>/<uuid>.log`
- The CLI writes the log header before execution starts, then appends rather than overwriting.
- JS and Rust pass the generated session name and canonical log path into isolation backends.
- Detached screen now starts with `-L` and a generated screenrc containing `logfile <tracked-log>` and `logfile flush 0`.
- Detached screen wraps the command so the command itself prints a final `Finished` and `Exit Code` footer through the same terminal stream captured by screen.
- JS direct execution writes stdout/stderr chunks to the log file as they arrive.
- Rust direct execution appends stdout/stderr lines to the log file as they arrive.
- Detached status enrichment reads the final `Exit Code` from the log after a detached session has ended.
- Local tmux/docker detached paths were updated to append live output to the canonical log when available; SSH detached mode now uses `/tmp/start-command/logs/isolation/ssh/<session>.log` on the remote host and reports that path.

## Verification

- JS focused regression: `bun test test/isolation-log-utils.test.js test/screen-integration.test.js`
- JS full tests: `bun test test/`
- JS checks: `bun run check`
- Rust full tests: `cargo test`
- Rust formatting: `cargo fmt --check`
