# Case Study: Issue #67 - Display Session Name and Container Name When Different from Session UUID

## Overview

**Issue:** When using isolation backends (screen, docker, tmux), the output shows a session UUID but not the actual container/screen/tmux session name that users need to reconnect to the session, especially in detached mode.

**Priority:** Bug / Enhancement / Documentation

## Problem Description

When running commands with isolation (screen, docker, tmux), the tool generates two different identifiers:
1. **Session UUID** - A unique identifier for tracking executions (e.g., `f1efebcd-5426-437b-92db-b94acaaf421c`)
2. **Session/Container Name** - The actual name used by the isolation backend (e.g., `docker-1767841051864-c0qs07`)

Currently, only the session UUID is displayed in output blocks, but users need the actual session/container name to:
- Reconnect to detached sessions (`screen -r <name>`, `tmux attach -t <name>`)
- View container logs (`docker logs <name>`)
- Attach to containers (`docker attach <name>`)
- Kill sessions (`screen -S <name> -X quit`, `docker rm -f <name>`)

## Root Cause Analysis

### Timeline of Code Flow

1. **Session UUID Generation** (`cli.js:234`):
   ```javascript
   const sessionId = wrapperOptions.sessionId || generateUUID();
   ```
   This generates the tracking UUID, e.g., `f1efebcd-5426-437b-92db-b94acaaf421c`

2. **Session Name Generation** (`cli.js:410-412`):
   ```javascript
   const sessionName = options.session ||
     `${environment || 'start'}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
   ```
   This generates the backend session name, e.g., `docker-1767841051864-c0qs07`

3. **Extra Lines for Isolation** (`cli.js:470-485`):
   Currently only adds:
   - `[Isolation] Environment: docker, Mode: attached`
   - `[Isolation] Session: <name>` (only if explicitly provided via --session)
   - `[Isolation] Image: ubuntu:latest`
   - `[Isolation] Endpoint: user@host` (for SSH)
   - `[Isolation] User: <user>` (for user isolation)

4. **Output Block Generation** (`output-blocks.js:181-205`):
   - Parses extraLines for isolation metadata
   - Generates spine lines with container/screen/tmux names
   - But the actual session name is **not passed** when auto-generated

### The Gap

The issue is in `cli.js` - when no explicit `--session` is provided, the auto-generated session name is not added to `extraLines`, so `output-blocks.js` cannot display it.

Currently:
```javascript
if (options.session) {
  extraLines.push(`[Isolation] Session: ${options.session}`);
}
```

This only adds the session line when user explicitly provides `--session`, but NOT when it's auto-generated.

## Proposed Solution

### Option 1: Always Add Session Name to extraLines (Recommended)

In `cli.js`, after generating `sessionName`, always add it to extraLines regardless of whether it was explicitly provided:

```javascript
// Always add the actual session/container name used
extraLines.push(`[Isolation] Session: ${sessionName}`);
```

This ensures that `output-blocks.js` can always display the correct session/container/screen name.

### Option 2: Use Session UUID for Session Names

Alternative approach: Try to use the session UUID as the session name when possible. However, this has limitations:
- UUIDs are long (36 characters) which may exceed name limits
- Some backends have character restrictions (docker container names must match `[a-zA-Z0-9][a-zA-Z0-9_.-]*`)
- UUIDs contain dashes which may cause issues in some contexts

### Recommendation

**Implement Option 1** - Always pass the actual session name to extraLines. This is:
- Minimal code change
- Backward compatible
- Provides users with the information they need
- Allows them to reconnect to detached sessions

## Implementation Steps

1. Modify `cli.js` to always add `[Isolation] Session: ${sessionName}` to extraLines
2. Add tests to verify the session name is displayed in output
3. Update any relevant documentation

## Impact

- **Users** will see the actual session/container name in output, enabling them to:
  - Reconnect to detached screen sessions
  - Attach to tmux sessions
  - View Docker container logs
  - Remove containers
- **Backward Compatibility**: No breaking changes - just additional information displayed

## References

- Issue: https://github.com/link-foundation/start/issues/67
- Related Files:
  - `js/src/bin/cli.js` - Main CLI logic
  - `js/src/lib/output-blocks.js` - Output formatting
  - `js/src/lib/isolation.js` - Isolation backend runners
  - `js/src/lib/args-parser.js` - Argument parsing

## User-Provided Log Examples

From the issue description:
```
$ --isolated screen -- echo 'hi'
│ session   a39a17a3-1064-480d-b508-80b8bdd3a93f
│ start     2026-01-08 02:57:28.115
│
│ isolation screen
│ mode      attached
│
$ echo hi
```

The screen session name (e.g., `screen-1767841048115-nch2wk`) is NOT shown, only the UUID.

With the fix, users would see:
```
│ session   a39a17a3-1064-480d-b508-80b8bdd3a93f
│ start     2026-01-08 02:57:28.115
│
│ isolation screen
│ mode      attached
│ screen    screen-1767841048115-nch2wk
│
$ echo hi
```

This allows users to reconnect with `screen -r screen-1767841048115-nch2wk`.
