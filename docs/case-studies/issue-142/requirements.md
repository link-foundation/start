# Requirements for Issue #142

| #   | Requirement                                                                  | Satisfied by                                                                                               |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| R1  | Make `$ --stop <session>` stop detached Docker isolation containers.         | Docker stop control now runs `docker stop <sessionName>`.                                                  |
| R2  | Preserve immediate termination behavior.                                     | Docker terminate control still runs `docker kill <sessionName>`.                                           |
| R3  | Cover the bug with tests because the issue suspected missing test coverage.  | JS and Rust execution-control tests assert Docker `--stop` uses `docker stop`.                             |
| R4  | Apply the fix across both maintained implementations.                        | `js/src/lib/execution-control.js` and `rust/src/lib/execution_control.rs`.                                 |
| R5  | Keep status, logs, and cleanup behavior compatible with detached Docker.     | The existing Docker completion watcher remains unchanged.                                                  |
| R6  | Compile issue data and analysis under `docs/case-studies/issue-142`.         | This folder contains issue metadata, PR data, requirements, timeline, root cause, solutions, and research. |
| R7  | Search online for Docker stop semantics and related facts.                   | See [online-research.md](online-research.md).                                                              |
| R8  | Remove contradictory repository guidance about Docker `--stop` using SIGINT. | Issue #112 case-study notes now document Docker `--stop` as `docker stop`.                                 |

## Derived Requirements

| #   | Requirement                                               | Reason                                                                     |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| D1  | Continue accepting UUIDs and session/container names.     | Existing `ExecutionStore.get()` lookup already supports both.              |
| D2  | Keep controls restricted to detached isolated executions. | Attached runs are foreground processes and are not targetable by record.   |
| D3  | Keep command execution through argv arrays.               | Avoids shell quoting risk for session/container names.                     |
| D4  | Keep output shape stable.                                 | `executionControl` links-notation remains unchanged except method/message. |
| D5  | Avoid adding a supervisor or polling loop for this bug.   | Docker already exposes the correct lifecycle operation.                    |
