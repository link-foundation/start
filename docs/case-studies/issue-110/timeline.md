# Timeline

| Time (UTC) | Event |
|------------|-------|
| 2026-04-24 11:47 | Issue #110 opened requesting a lino-formatted list of all stored command executions. |
| 2026-04-24 11:47 | PR #111 created as a draft with only the placeholder `.gitkeep`. |
| 2026-04-24 11:51 | JS reproduction confirmed: `bun js/src/bin/cli.js --list` executes `--list` via `/bin/sh` and exits 2. |
| 2026-04-24 11:52 | Rust reproduction confirmed: `cargo run -- --list` has the same shell failure. |
| Investigation | Related PRs #102, #106, and #107 showed the established pattern for status query parity and record enrichment. |
| Implementation | Added `--list` parser state, list formatters, CLI handlers, tests, and documentation for both runtimes. |

