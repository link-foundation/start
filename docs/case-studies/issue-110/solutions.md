# Solution Options

## Option A: Expose `ExecutionStore.getAll()` through `--list` (chosen)

Use the existing execution store APIs, sort records by `startTime` descending,
reuse detached-status enrichment and `currentTime`, then format the collection.

Advantages:

- Smallest behavioral change.
- Works for both JS and Rust with the same shape.
- Reads the same data that `--status` uses.
- Keeps the default output in Links Notation.

Trade-off:

- It lists every stored record. A future issue may add filtering or pagination
  if stores become very large.

## Option B: Read `executions.lino` directly from the CLI

This would decode the backing file in the CLI instead of using `ExecutionStore`.

Rejected because:

- It duplicates storage logic.
- It bypasses future store consistency behavior.
- It would make Rust and JS parity harder to maintain.

## Option C: Query the `.links` database with `clink`

The repository can optionally write to a `.links` database when `clink` is
available.

Rejected for this issue because:

- The `.lino` file is the guaranteed local store.
- `clink` is optional.
- `--status` already uses `ExecutionStore`, not a direct `clink` query.

## Option D: List live multiplexer sessions directly

For isolated detached jobs, tools like GNU Screen and tmux already provide list
commands for their own sessions.

Rejected as the main implementation because:

- The issue asks for commands stored for `--status`, not only live screen/tmux
  sessions.
- Direct multiplexer lists would miss direct executions, completed executions,
  Docker records, and SSH records.

The final implementation still reuses the existing detached-status enrichment
logic, so live session checks continue to improve record accuracy when possible.

