# Case Study: Issue #101 - --session name not usable with --status, and --detached reports immediate completion

## Overview

**Issue:** Two bugs prevent reliable session tracking when using `--isolated screen --detached --session <custom-name>`:
1. `--status <custom-name>` fails because lookup only works by internal UUID
2. `--detached` reports immediate completion because it tracks the wrapper process, not the actual session

**Priority:** Bug
**Related:** [link-assistant/hive-mind#1545](https://github.com/link-assistant/hive-mind/issues/1545), Issue #67 (session name display)

## Problem Description

When a user starts a long-running command with a custom session name:
```bash
$ --isolated screen --detached --session my-custom-session -- sleep 60
```

Two issues arise:
1. `$ --status my-custom-session` returns "No execution found with UUID: my-custom-session"
2. `$ --status <internal-uuid>` shows `status: executed, exitCode: 0` immediately, even though the screen session is still running `sleep 60`

## Root Cause Analysis

### Root Cause 1: UUID-only lookup in ExecutionStore.get()

**JS:** `execution-store.js:477-480`
```javascript
get(uuid) {
  const records = this.readLinoRecords();
  const found = records.find((r) => r.uuid === uuid);
  return found || null;
}
```

**Rust:** `execution_store.rs:522-525`
```rust
pub fn get(&self, uuid: &str) -> Option<ExecutionRecord> {
    self.read_lino_records()
        .into_iter()
        .find(|r| r.uuid == uuid)
}
```

The `get()` method only searches by the `uuid` field. The `--session` name is stored in `options.sessionName` but is never consulted during lookups. The `--status` flag accepts any string (not validated as UUID), but the store can only match by UUID.

### Root Cause 2: Immediate completion marking for detached mode

**JS:** `cli.js:605-619`
```javascript
// After runIsolated() returns:
executionRecord.complete(exitCode);
store.save(executionRecord);
```

When `--detached` is used, `runIsolated()` starts the screen/tmux/docker session and returns immediately (the wrapper process exits). The code then marks the execution as "executed" with `exitCode: 0` because the wrapper exited successfully. But the actual screen session is still running the command.

### Root Cause 3 (Rust-only): Missing execution tracking in run_with_isolation

**Rust:** `main.rs:422-644`

The `run_with_isolation()` function did not create any `ExecutionRecord` at all. Execution records were only created in `run_direct()` (line 730). This meant `--status` could never find any isolation-mode execution in the Rust implementation.

### Timeline of Events

1. User runs `$ --isolated screen --detached --session my-session -- sleep 60`
2. `parseArgs()` extracts `--session my-session` into `options.session`
3. `cli.js:234` generates `sessionId` as a new UUID (e.g., `abc123...`)
4. `cli.js:411-413` sets `sessionName = options.session` (= `my-session`)
5. `cli.js:496-512` creates `ExecutionRecord` with `uuid: sessionId` and `options.sessionName: my-session`
6. `runIsolated("screen", cmd, {detached: true, session: "my-session"})` starts screen and returns immediately
7. `cli.js:607` calls `executionRecord.complete(0)` - **BUG: marks as executed immediately**
8. User tries `$ --status my-session` - **BUG: get() only checks r.uuid, not r.options.sessionName**

## Fix Implementation

### Fix 1: Session name fallback in ExecutionStore.get()

Modified `get()` to try UUID match first, then fall back to session name lookup:

```javascript
get(identifier) {
  const records = this.readLinoRecords();
  const byUuid = records.find((r) => r.uuid === identifier);
  if (byUuid) return byUuid;
  const bySessionName = records.find(
    (r) => r.options && r.options.sessionName === identifier
  );
  return bySessionName || null;
}
```

UUID match takes priority to maintain backward compatibility.

### Fix 2: Detached status enrichment

Added `enrichDetachedStatus()` which is called during `queryStatus()`. For detached executions, it checks if the actual session is still running:
- **screen:** Checks `screen -ls` output for session name
- **tmux:** Runs `tmux has-session -t <name>`
- **docker:** Runs `docker inspect -f "{{.State.Running}}" <name>`
- **ssh:** Checks if wrapper PID is still running

If the session is no longer running but the record says "executing", it updates the status to "executed" with `exitCode: -1`. If the session is still running but the record says "executed", it corrects back to "executing".

### Fix 3: Keep detached records as "executing"

Modified the isolation completion code to NOT call `record.complete()` for detached mode. The real status is determined at query time by checking if the session is still alive.

### Fix 4 (Rust): Add execution tracking to run_with_isolation

Added `ExecutionRecord` creation, saving, and completion to `run_with_isolation()` with full isolation options (`sessionName`, `isolated`, `isolationMode`, `image`, `endpoint`, `user`, `keepAlive`).

## Affected Components

| Component | File | Change |
|-----------|------|--------|
| JS ExecutionStore | `js/src/lib/execution-store.js` | `get()` supports session name fallback |
| JS StatusFormatter | `js/src/lib/status-formatter.js` | Added `isDetachedSessionAlive()`, `enrichDetachedStatus()` |
| JS CLI | `js/src/bin/cli.js` | Detached mode keeps status as "executing" |
| JS ArgsParser | `js/src/lib/args-parser.js` | Updated help text |
| Rust ExecutionStore | `rust/src/lib/execution_store.rs` | `get()` supports session name fallback |
| Rust StatusFormatter | `rust/src/lib/status_formatter.rs` | Added `is_detached_session_alive()`, `enrich_detached_status()` |
| Rust CLI | `rust/src/bin/main.rs` | Added execution tracking to `run_with_isolation()`, detached keeps "executing" |
| Rust ArgsParser | `rust/src/lib/args_parser.rs` | Updated help text |

## Testing

- **JS:** 15 new tests in `test/session-name-status.test.js`
- **Rust:** 12 new tests in `tests/session_name_status_test.rs`
- All existing tests pass (7 JS status-query tests, full Rust test suite)

## Workarounds (from hive-mind)

Before this fix, users worked around the issue by:
1. Extracting the internal UUID from `$` output and using that for `--status` queries
2. Falling back to `screen -ls` to check if the screen session is still active

These workarounds are no longer necessary after this fix.
