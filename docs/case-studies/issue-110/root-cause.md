# Root Cause

## Observable failure

`--list` was not recognized as a wrapper option in either implementation. The
custom parser treats an unknown option as the beginning of the command, so the
CLI attempted to execute the literal command `--list` through `/bin/sh`.

That produced:

```text
/bin/sh: 0: Illegal option --
```

## Missing pieces

1. **No parser field or option branch**
   - JS `WrapperOptions` did not include `list`.
   - Rust `WrapperOptions` did not include `list`.
   - Neither `parseOption` function recognized `--list`.

2. **No CLI query handler**
   - `--status` had a top-level handler before command execution.
   - `--cleanup` had a top-level handler before command execution.
   - `--list` had no equivalent handler, so execution continued into normal command mode.

3. **No list formatter**
   - Single-record formatters existed for Links Notation, JSON, and text.
   - There was no formatter for a collection of execution records.

## Existing code that made the fix small

The storage layer already had the important retrieval APIs:

- JS: `ExecutionStore.getAll()`, `getRecent()`, `getByStatus()`.
- Rust: `ExecutionStore::get_all()`, `get_recent()`, `get_by_status()`.

The fix therefore did not need a new database format. It only needed to expose
an existing collection query through parser, formatter, and CLI layers.

