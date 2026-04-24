# Requirements for Issue #110

| # | Requirement | Satisfied by |
|---|-------------|--------------|
| R1 | Add a way to list every previously executed and currently executing command that is stored for `--status`. | New `--list` query mode reads all `ExecutionStore` records. |
| R2 | The list should be Links Notation / lino-style by default. | `formatRecordListAsLinksNotation()` in JS and `format_record_list_as_links_notation()` in Rust. |
| R3 | Implement the behavior in JavaScript. | `js/src/lib/args-parser.js`, `js/src/lib/status-formatter.js`, `js/src/bin/cli.js`. |
| R4 | Implement the behavior in Rust. | `rust/src/lib/args_parser.rs`, `rust/src/lib/status_formatter.rs`, `rust/src/bin/main.rs`. |
| R5 | Include both completed and currently executing records. | `listExecutions()` / `list_executions()` reads `getAll()` / `get_all()` and preserves status enrichment. |
| R6 | Do not break existing `--status` behavior. | Existing status tests still pass, and list mode uses separate parser and formatter paths. |
| R7 | Compile related issue data under `docs/case-studies/issue-110`. | This folder contains issue JSON, comments JSON, related PR data, and analysis files. |
| R8 | Review existing components/libraries and possible solution plans. | See [solutions.md](solutions.md) and [online-research.md](online-research.md). |

## Derived requirements

| # | Requirement | Reason |
|---|-------------|--------|
| D1 | Support `--output-format json` and `--output-format text` for `--list`. | `--status` already supports these query formats; list mode should be predictable. |
| D2 | Show `currentTime` for executing records in list output. | `--status` already enriches executing records this way; list output should not lose that field. |
| D3 | Keep records sorted newest first. | A list of command executions is most useful when the most recent command is visible first. |
| D4 | Return a tracking-disabled error when `START_DISABLE_TRACKING=1`. | Same behavior as `--status`; there is no store to list. |

