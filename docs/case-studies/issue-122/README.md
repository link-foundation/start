# Case Study - Issue #122: CI/CD is broken

- Issue: https://github.com/link-foundation/start/issues/122
- Pull Request: https://github.com/link-foundation/start/pull/123
- JavaScript run cited by the issue: https://github.com/link-foundation/start/actions/runs/25286510018/job/74131657798
- Rust run cited by the issue: https://github.com/link-foundation/start/actions/runs/25286510029/job/74131749322

## Documents in this folder

| File                     | Purpose                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `requirements.md`        | Explicit and implied requirements from issue #122.                                                 |
| `timeline.md`            | Sequence of events reconstructed from GitHub issue, PR, and CI data.                               |
| `root-cause.md`          | Root causes for each broken CI/CD behavior, with log references.                                   |
| `solutions.md`           | Implemented fixes, verification plan, and alternatives considered.                                 |
| `template-comparison.md` | Audit against JS, Rust, Python, and C# pipeline templates.                                         |
| `online-research.md`     | External documentation used to validate the solution.                                              |
| `ci-logs/`               | Raw `gh run view --log` output for the two cited workflow runs and follow-up PR verification runs. |
| `templates/`             | Snapshot of relevant workflow and release helper files from templates.                             |
| `issue-data.json`        | Snapshot of issue #122 metadata and body.                                                          |
| `issue-comments.json`    | Snapshot of issue comments; empty at investigation time.                                           |
| `recent-runs.json`       | Snapshot of recent workflow runs around the incident.                                              |
| `ci-run-*.json`          | Metadata snapshots for the two cited workflow runs.                                                |
| `pr-123.json`            | Snapshot of the initial prepared pull request.                                                     |

## Summary

The JavaScript CI failure was a test timeout, not an application cleanup
failure. The Windows Bun test job spent about 16 seconds in a Docker cleanup
test that still had Bun's default 5 second timeout. Other Docker cleanup tests
already used larger per-test timeouts.

The Rust release problem was more serious: the workflow reported success while
it did not publish `start-command` to crates.io. The release job had no
`cargo publish` step, and its GitHub release helper ignored a failing `gh api`
call. The log shows a GitHub HTTP 422 `already_exists` response immediately
followed by a success message.

The fix makes the JavaScript Docker cleanup test timeout explicit, adds a
checked and idempotent GitHub release helper, adds an idempotent crates.io
publish script, gates the Rust GitHub Release on successful crates.io publish,
and upgrades the Rust package check from `cargo package --list` to a full
`cargo package --allow-dirty` verification. Packaging also required making
`start-command` depend on the published `lino-objects-codec = "0.2.0"` API and
adapting `.lino` conversion code to `LinoValue`.

The same false-positive GitHub release helper pattern was found in the JS
pipeline template and was reported upstream:

- https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/49

Fresh PR CI logs were also preserved after the first implementation push. Those
runs exposed Windows-only fake command shim issues in the new JS tests and a
Rust/JS test parity deficit from adding JS tests. The follow-up fix made the
test command shims injectable on every platform and added five focused Rust
tests for JSON/LinoValue conversion.
