# Requirements and disposition

## Issue requirements

| ID  | Requirement                                                                                            | Disposition                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Detect the fatal memory marker from the log tail, with a 64 KiB window rather than 16 KiB.             | Complete. `FATAL_MARKER_TAIL_BYTES = 64 * 1024` in both implementations; `enrich_detached_status` reads the tail once at that width and shares it.             |
| R2  | Report the matched **line**, not just a category, as the evidence.                                     | Complete. `detectMemoryMarker` / `detect_memory_marker` return `{reason, line}`; the line is trimmed and bounded to 300 characters before it travels in output. |
| R3  | Expose it as an observation, never a verdict: only for `exitCode !== 0 && exitCode !== null`.          | Complete. `resolveMemoryExhaustion` / `resolve_memory_exhaustion` return nothing for a clean or unknown exit, so a quoted marker cannot fail a successful run.  |
| R4  | Add `memoryExhausted` / `memoryExhaustedReason` next to `oomKilled` in the execution record output.    | Complete. `toObject()` emits both after `exitReason`; the Rust record carries `memory_exhausted` / `memory_exhausted_reason` with `skip_serializing_if`.        |
| R5  | Add the fields to the human-readable formatter (`Memory Exhausted:  true`).                            | Complete. `Memory Exhausted:` and `Memory Evidence:` follow `Exit Reason:` in both text formatters.                                                             |
| R6  | Stop the kept-container footer from asserting a bare `oomKilled=false` next to a fatal marker.         | Complete. The watcher computes `$__start_command_reason`; for exit `134`/`139` with `oomKilled=false` it appends a note that the flag cannot see a self-abort.  |
| R7  | Apply the detection to attached sessions too, not only `enrichDetachedStatus`.                         | Complete twice over: `enrichDetachedStatus` runs for every record `--status`/`--list` returns, and the attached kept-container message names the evidence line. |
| R8  | Cover the runtimes in the issue's pattern table (V8, Rust, C++, Go, array buffers).                    | Complete. The existing marker table already carried V8, Rust, C++ and the kernel killer; this PR adds the Go runtime OOM and `Array buffer allocation failed`.  |
| R9  | The new fields must not contradict or replace `oomKilled`, which is correct as recorded.               | Complete by construction. `status`, `exitCode` and `oomKilled` are never written by the new code path; `oomKilled=true` is also accepted as evidence in itself. |

## Implicit repository requirements

| ID  | Requirement                                                | Disposition                                                                                                                             |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| R10 | JavaScript and Rust must stay behaviourally at parity.     | Complete. Same helper names, same 64 KiB window, same field names, same footer note, same text labels, mirrored unit and CLI-level tests. |
| R11 | No source file may exceed 1000 lines.                      | Complete. The attached kept-container message moved into `docker-cleanup.js` as `buildAttachedDockerKeptMessage`, keeping `isolation.js` under the limit. |
| R12 | Tests must not require Docker, screen, tmux or a network.  | Complete. The suites write synthetic logs and drive the real CLI; the footer snippet is evaluated by `sh`, not by Docker.                 |
| R13 | Documentation must cover the new fields.                   | Complete. `README.md`'s exit-reason section now documents both fields and the reason a container flag cannot see a self-abort.            |
| R14 | Release metadata must accompany releasable source changes. | Complete. `js/.changeset/issue-165.md` and `rust/changelog.d/165.md`, both `minor`.                                                       |

## Verification requirements

| ID  | Requirement                                                          | Evidence                                                                                                                       |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| V1  | A regression test reproduces the reported false negative.            | `js/test/regression-165.js` and `rust/tests/regression_165.rs` save a 139 record with the incident's log and assert the fields. |
| V2  | The 64 KiB window is actually required by the test, not just claimed. | Both suites push the marker past 32 KiB from EOF with a synthetic native stack trace and assert it is still found.              |
| V3  | A clean run that prints the marker stays clean.                       | Both suites assert no fields for `Exit Code: 0` with the marker quoted in the output.                                          |
| V4  | The footer no longer contradicts the log.                             | Both suites evaluate the generated reason snippet in a real `sh` for `134`, `139`, `1` and `137`.                              |
| V5  | Full local CI passes before pushing.                                  | `data/local-*.log` cover both suites, lint, format, Clippy, file size and doc examples.                                        |
