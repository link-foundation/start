# Requirements for Issue #112

| #   | Requirement                                                                          | Satisfied by                                                                                                               |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| R1  | Add `--stop <id>` for commands started with `isolationMode detached`.                | JS/Rust parsers and CLIs route `--stop` to detached execution control helpers.                                             |
| R2  | `--stop` should send CTRL+C or equivalent graceful interrupt to the command process. | screen uses `screen -S <session> -X stuff <Ctrl-C>`, tmux uses `send-keys C-c`, Docker uses `docker kill --signal=SIGINT`. |
| R3  | Add `--terminate <id>` for immediate termination.                                    | screen uses `quit`, tmux uses `kill-session`, Docker uses default `docker kill`.                                           |
| R4  | Accept either execution UUID or isolation session/container name.                    | Existing `ExecutionStore.get()` session-name fallback is reused.                                                           |
| R5  | Restrict controls to detached isolated executions.                                   | Control helpers reject missing session names and non-detached records.                                                     |
| R6  | `--status` should provide process IDs for command and isolation backend/container.   | Status/list enrichment adds `processIds` with wrapper PID and backend-specific IDs when available.                         |
| R7  | Implement JavaScript behavior.                                                       | `js/src/lib/execution-control.js`, parser, CLI, status formatter, and tests.                                               |
| R8  | Implement Rust behavior.                                                             | `rust/src/lib/execution_control.rs`, parser, CLI, status formatter, and tests.                                             |
| R9  | Compile issue data and case-study analysis under `docs/case-studies/issue-112`.      | This folder contains issue metadata, related PRs, requirements, root cause, solution options, timeline, and research.      |
| R10 | Search online for facts and related components/libraries.                            | See [online-research.md](online-research.md).                                                                              |

## Derived requirements

| #   | Requirement                                                            | Reason                                                                                                              |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D1  | Make query/control modes mutually exclusive.                           | `--status`, `--list`, `--stop`, `--terminate`, and `--cleanup` are top-level operations with incompatible behavior. |
| D2  | Keep `--output-format` read-only.                                      | Control operations emit a fixed Links Notation result rather than status/list format variants.                      |
| D3  | Preserve detached status enrichment.                                   | Existing issue #101 behavior must continue to correct stale detached records at query time.                         |
| D4  | Store Docker container IDs when available.                             | Docker names are targetable, but container IDs make status output more precise.                                     |
| D5  | Use command argv arrays rather than shell strings for native controls. | Avoids quoting bugs and command injection risk around session names.                                                |
