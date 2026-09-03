# Requirements and disposition

## Issue requirements

| ID  | Requirement                                                                                       | Disposition                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `--attach <uuid-or-session>` attaches to a running detached session's terminal.                   | Complete. `execution-attach` / `execution_attach` probe the session, then hand the terminal over via `docker attach`, `screen -r` or `tmux attach`. |
| R2  | `--attach <id> --read-only` follows output without forwarding stdin.                              | Complete. The plan switches to `docker logs -f` / `screen -x` / `tmux attach -r`; `--read-only` without `--attach` is rejected at parse time.       |
| R3  | `--resume <uuid-or-session>` restarts the stored command in the same container.                   | Complete. A stopped container is restarted in place (`docker start`); the stored command is reused when no replacement is given.                    |
| R4  | `--resume <uuid-or-session> -- <new command>` runs a different command in the same context.       | Complete, and treated as the primary form. The container is snapshotted with `docker commit` and the new command runs against that image.           |
| R5  | Keep the same execution UUID / session name so `--status`, `--list`, `--upload-log` keep working. | Complete. The UUID never changes; the previous container name is appended to `sessionNameHistory` and still resolves in every lookup.               |
| R6  | `--resume-all` re-attaches or resumes every execution still marked running.                       | Complete. Each still-running record is probed and classified `reattached`, `running`, `reconciled` or `unknown`.                                    |
| R7  | `--list --running` exposes the machine-readable set that drives `--resume-all`.                   | Complete. `list_executions_filtered` / `listExecutions` filter on the running status; `--running` without `--list` is rejected.                     |
| R8  | Surface an `exitReason` hint when the log contains a fatal memory marker.                         | Complete. `exit-reason` / `exit_reason` detects the V8 heap-limit abort and reports `memory-exhaustion (v8-heap-limit)`.                            |
| R9  | The hint must not contradict `oomKilled`, which is correct as recorded.                           | Complete by construction: `exitReason` is additive and never mutates `status`, `exitCode` or `oomKilled` (#148/#151).                               |
| R10 | Replace the misleading `docker exec` / `docker start -ai` recovery guidance.                      | Complete. Retained-container guidance in both implementations now points at `--attach` and `--resume`.                                              |

## Implicit repository requirements

| ID  | Requirement                                                | Disposition                                                                                                         |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| R11 | JavaScript and Rust must stay behaviourally at parity.     | Complete. Every verb, option, error string and output format exists in both, with mirrored module layouts.          |
| R12 | No source file may exceed 1000 lines.                      | Complete. `query_commands.rs` and `execution_store_cases.rs` were extracted to keep `main.rs` and the store under.  |
| R13 | Tests must not require Docker, screen, tmux or a network.  | Complete. Rust injects `CommandRunner`, `InteractiveRunner` and `ResumeHooks`; JavaScript injects equivalent fakes. |
| R14 | Documentation must cover every new verb.                   | Complete in `README.md`, `docs/USAGE.md`, `js/README.md`, `rust/README.md` and both usage screens.                  |
| R15 | Release metadata must accompany releasable source changes. | Complete. `js/.changeset/issue-162.md` and `rust/changelog.d/163.md`, both `minor`, both validated locally.         |

## Verification requirements

| ID  | Requirement                                        | Evidence                                                                                                        |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| V1  | A regression test reproduces the reported gap.     | `js/test/regression-162.js` and `rust/tests/regression_162.rs` drive the real CLI end to end.                   |
| V2  | The `exitCode 139` incident is reproduced exactly. | Both suites write a log containing the V8 heap-limit marker and assert `exitReason` while `exitCode` stays 139. |
| V3  | The orphaned-record scenario is reproduced.        | Both suites save a record stuck in `executing`, run `--resume-all`, and assert it becomes `executed`.           |
| V4  | Session identity survives a resume.                | Both suites resolve a record by a name held only in `sessionNameHistory`.                                       |
| V5  | Full local CI passes before pushing.               | `data/local-*.log` cover both suites, lint, format, Clippy, file size, doc examples, parity and changesets.     |
