---
'start-command': minor
---

Upgrade every dependency to its latest release, and let CI reject pull requests that fall behind (#253).

- **Upgrades:** `@link-foundation/sensitive-data-sanitizer` 0.12.2, `command-stream` 2.6.0, `lino-objects-codec` 0.9.3, the lint tools, the GitHub Actions, the runners (`ubuntu-26.04`, `macos-26`) and the .NET 10 SDK that clink 4.x needs.
- **Store format:** the execution store is now written in lino-objects-codec 0.9's readable format. Stores written by older releases are still read, but older releases of start cannot read a store written by this one.
- **Links database:** the store had stayed empty, because clink 4.x rejected every query it sent. It now writes one record-scoped link per property and verifies the writes.
- **`--use-command-stream`:** command output is appended to the log again. command-stream 2.x returns it as snapshots.
- **Sanitizer:** start's own `Authorization` masking pass is gone, because the sanitizer now masks only the scheme and token itself. A NUL byte in a log no longer blocks the upload (`--allow-binary`).
- **Dependency fixes:** preserve Authorization placeholders, bracketed tokens and following control bytes; avoid quadratic scanning of dense credentials. Load command-stream's lightweight `core` entry for command execution.
- **CI:** `scripts/check-dependency-freshness.mjs` fails a pull request when any npm package, crate, action, CI tool, runtime, runner or translator pin is not its latest release. The one exception is a version that links an open blocking issue.
