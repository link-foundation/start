# Root Cause

The repository already tracked detached isolated executions, including
`options.isolated`, `options.isolationMode`, and `options.sessionName`, but the
CLI exposed only read-only operations:

- `--status <id>`
- `--list`
- `--cleanup`

There was no parser state, CLI dispatch, or backend-control abstraction for
targeting a tracked detached screen, tmux, or Docker session after the wrapper
process had exited.

The status formatter also serialized only the wrapper record's `pid` field.
For detached sessions that value identifies the start-command wrapper process,
not necessarily the live backend session or command process. Backend-specific
process discovery was missing:

- GNU Screen session PID from `screen -ls`.
- tmux server/pane process IDs from format variables.
- Docker container ID and host-side init PID from `docker inspect`.
- Descendant command PIDs from parent-PID traversal where available.

The fix adds a shared control/discovery layer in both implementations and wires
it into parser, CLI, and status/list formatting.
