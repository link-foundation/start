# Online Research

The implementation primarily uses existing repository components. External
research was used to compare the requested `--list` behavior with established
CLI/session-listing patterns.

## Sources reviewed

- [GNU Screen manual: Invoking Screen](https://www.gnu.org/software/screen/manual/html_node/Invoking-Screen.html)
  - `screen -ls` / `screen -list` is a precedent for listing managed sessions
    without starting a new one.
- [OpenBSD tmux(1) manual](https://man.openbsd.org/OpenBSD-current/man1/tmux.1)
  - `list-sessions` / `ls` is the tmux equivalent for listing sessions managed
    by its server.
- [clap `ArgAction`](https://docs.rs/clap/latest/clap/builder/enum.ArgAction.html)
  - `SetTrue` is the common Rust parser pattern for boolean flags. The Rust
    implementation currently uses a custom parser, so the local fix mirrors
    existing code instead of introducing clap.
- [lino-objects-codec package metadata](https://www.jsdelivr.com/package/npm/lino-objects-codec)
  - Confirms the existing JS dependency used by `ExecutionStore` for lino-style
    object serialization.

## Findings

Existing tools distinguish between "run a command" and "query/list state" at
the CLI layer. start-command already had this split for `--status` and
`--cleanup`; `--list` belongs in the same query category.

External multiplexer commands are useful precedents, but they are not sufficient
as the implementation because start-command tracks more than live multiplexer
sessions. The authoritative source is the execution store used by `--status`.

