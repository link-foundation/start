# Requirements and disposition

## Issue requirements

| ID  | Requirement                                                                                  | Disposition                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `$ node -e "console.log('hi')"` must print `hi` instead of a shell syntax error.             | Complete. The argument is quoted before the join, so the inner shell receives it as one word. Covered end to end in both regression suites. |
| R2  | `$ echo "a  b"` must print `a␣␣b` on the direct path and under Docker isolation.             | Complete. Quoting preserves the run of spaces; the isolation paths consume the same repaired string.                                       |
| R3  | `$ bash -c "echo hello world"` must work in the default, non-isolated mode.                  | Complete. The script reaches `bash -c` as one argument, and `isShellInvocationWithArgs` still prevents a second wrapping.                   |
| R4  | `$ bash -c "echo $((1+1))"` must print `2`.                                                  | Complete, asserted end to end in both suites.                                                                                              |
| R5  | A single argument must keep running verbatim as a shell script.                              | Complete. `buildCommandString` returns `argv[0]` unchanged for one element, so `$ 'ls \| wc -l'` is unaffected.                             |
| R6  | Several arguments must be shell-quoted element by element.                                   | Complete, via `quoteShellArg` / `quote_shell_arg` with minimal quoting.                                                                     |
| R7  | Make the faithful argv the single source of truth rather than a discarded field.             | Complete in effect: the rebuild is lossless, so `command` now carries the argv faithfully. `rawCommand` stays as the unquoted array.        |
| R8  | State the `$ echo a '&&' echo b` trade-off plainly rather than leaving it to be discovered.  | Complete. `docs/USAGE.md#argument-boundaries`, `README.md` and both changesets record it; both packages take a `minor` bump.                |
| R9  | Consider an opt-out flag if the old behaviour must be preserved.                             | Considered and rejected; the reasoning is in `solutions.md`. The single-argument script form is the documented escape hatch.                |
| R10 | Ship the regression tests suggested in the issue.                                            | Complete. All four suggested assertions exist in both suites, plus 24 more per implementation.                                             |

## Implicit repository requirements

| ID  | Requirement                                                    | Disposition                                                                                                             |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R11 | JavaScript and Rust must stay behaviourally at parity.         | Complete. `shell-utils.js` and `isolation_shell.rs` expose the same helpers with the same semantics.                     |
| R12 | Earlier fixes #84 and #91 must keep working.                   | Complete. Their helpers were rebuilt on a quote-aware tokeniser rather than retired; their existing tests still pass.    |
| R13 | The natural-language substitution engine must keep matching.   | Complete. Quoting is minimal, so `install lodash npm package` still matches its rule; the substitution suite is green.   |
| R14 | The displayed `$ …` line must match what actually runs.        | Complete. `buildDisplayCommand` re-derives the line from tokens and prefers the user's quoting style.                    |
| R15 | Documented examples must keep validating.                      | Complete. `docs/examples/tested-examples.json` is updated for the new parse result; both doc-example checks pass.        |
| R16 | Release metadata must accompany releasable source changes.     | Complete. `js/.changeset/issue-164.md` and `rust/changelog.d/164.md`, both `minor` for the behaviour change.             |

## Verification requirements

| ID  | Requirement                                              | Evidence                                                                                        |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| V1  | Reproduce the reported failures before fixing them.      | `experiments/issue-164-repro.mjs`, with `data/repro-before.log` and `data/repro-after.log`.      |
| V2  | Regression tests fail on the old code and pass on the new. | `js/test/regression-164.js`, `rust/tests/regression_164.rs`; logs in `data/*-focused-test.log`. |
| V3  | The single-argument script form is protected by a test.  | Both suites run `'echo one \| tr a-z A-Z'` end to end and assert the pipeline result.            |
| V4  | Full local CI passes before pushing.                     | `data/local-*.log` cover both suites, lint, format, Clippy, file size, doc examples and parity.  |
