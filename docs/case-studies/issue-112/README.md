# Case Study: Issue #112 - Stop and terminate detached executions

## Summary

Issue #112 asks for two control commands for executions started with
`isolationMode detached`:

- `--stop <id>` should send CTRL+C or the backend's interrupt signal so the
  command can finish gracefully.
- `--terminate <id>` should end the detached execution immediately.
- `--status` should include process IDs for the wrapper, command, and isolation
  backend/container when available.

The issue also requires JavaScript and Rust parity, online research, related
data capture, and solution planning in this folder.

## Contents

- `issue-data.json` - issue metadata from GitHub.
- `issue-comments.json` - issue comments from GitHub.
- `related-prs.json` - related merged pull requests reviewed during analysis.
- [requirements.md](requirements.md) - requirements extracted from the issue.
- [timeline.md](timeline.md) - investigation and implementation sequence.
- [root-cause.md](root-cause.md) - why the feature was missing.
- [solutions.md](solutions.md) - options considered and chosen plan.
- [online-research.md](online-research.md) - external references reviewed.

## Fixed behavior

```bash
$ --stop 29d6c026-b168-44a6-8a3f-c3919c7e5327
executionControl
  action stop
  status signal-sent
  method CTRL_C

$ --terminate 29d6c026-b168-44a6-8a3f-c3919c7e5327
executionControl
  action terminate
  status terminated
```

`--status` and `--list` now include best-effort `processIds` in query output
when the execution store has a wrapper PID or when screen, tmux, Docker, or SSH
metadata can be resolved.

## Verification

Focused checks for this issue:

```bash
cd js
bun test test/args-parser.test.js test/status-query.test.js test/execution-control.test.js

cargo test --manifest-path rust/Cargo.toml --test args_parser_test --test status_formatter_test --test execution_control_test
```
