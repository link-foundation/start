# CI investigation

[Run 38140254772](https://github.com/link-foundation/start/actions/runs/38140254772)
started at 2026-10-11 12:41:59 UTC on
`8134902ecbc31d970c94a48dac214d9b38249816` and completed with failure at
12:48:14 UTC. The complete JavaScript stage passed first. The independent
security and broken-link workflows passed on the same commit.

All six failed jobs were collected after completion. The following line numbers
refer to the preserved, unmodified individual job logs:

| Job | Evidence | Failure |
| --- | --- | --- |
| Rust lint and format | [Raw log](../../../../ci-logs/issue-207-ci-38140254772-lint.txt), line 589 | E0425, `cores` referenced before declaration at `cpu_penalty_monitor.rs:192:73` |
| Rust coverage | [Raw log](../../../../ci-logs/issue-207-ci-38140254772-coverage.txt), lines 649–662 | Same E0425; compilation stops, followed by broken-pipe and empty-coverage errors |
| Rust Windows tests | [Raw log](../../../../ci-logs/issue-207-ci-38140254772-windows.txt), line 601 | Same E0425 |
| Rust Ubuntu tests | [Raw log](../../../../ci-logs/issue-207-ci-38140254772-ubuntu.txt), line 666 | Same E0425 |
| Rust macOS tests | [Raw log](../../../../ci-logs/issue-207-ci-38140254772-macos.txt), line 594 | Same E0425 |
| Required Rust stage | [Raw log](../../../../ci-logs/issue-207-ci-38140254772-stage.txt), lines 235–241 | Aggregates lint, test and coverage failures; no separate defect |

The new optional debug trace used the computed CPU usage before its `let cores`
declaration. The correction moves that trace after the measurement, matching
JavaScript. This changes neither policy nor timeouts. All prior branch runs were
complete before pushing the correction, and commit history is preserved.

After the correction, local JavaScript check and all 1,220 tests pass again;
Rust formatting also passes. Native compilation and tests remain in the existing
JavaScript-gated CI stage because the local container has a 2.92-GiB memory limit.
Final same-commit results are linked from
[PR 208](https://github.com/link-foundation/start/pull/208).
