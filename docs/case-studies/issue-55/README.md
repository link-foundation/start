# Case Study: Issue #55 - Multiple Issues with Output Consistency

## Summary

Issue #55 reports multiple problems with the `start-command` CLI tool output:
1. `$ echo 'hi'` (no isolation) does not show the command's output - only shows the start block, not the finish block
2. Missing empty lines before and after command output for all isolation modes and no-isolation
3. Data in blocks is truncated (log paths not fully copyable)
4. Need for unified template across all isolation modes
5. Request to ensure `echo "hi"` works reliably in all modes with proper testing

## Timeline of Events

### Prior Issues (Context)
This is reported as the 3rd time the user has requested `echo "hi"` to work properly, indicating a recurring problem that wasn't fully resolved.

### Issue #55 Report (2026-01-06)
User provided detailed examples showing:

1. **No Isolation Mode (`$ echo 'hi'`)**:
   - Only shows start block
   - Missing command output
   - Missing finish block

2. **Screen Isolation (`$ --isolated screen -- echo 'hi'`)**:
   - Shows both blocks properly
   - Has output correctly displayed
   - But formatting inconsistencies exist

3. **Docker Isolation (`$ --isolated docker --image ubuntu -- echo 'hi'`)**:
   - Works similarly to screen
   - Same formatting issues

## Root Cause Analysis

After analyzing the codebase, I identified the following root causes:

### 1. Missing Output in No-Isolation Mode

In `js/src/bin/cli.js`, the `runDirect()` function:
- Correctly captures stdout/stderr from child process
- Writes to log file properly
- BUT: The output is shown in real-time BUT the issue is that there's NO empty line printed before the command output, making it appear as though output is missing

Looking at the code:
```javascript
// Line 598-605 in cli.js
console.log(
  createStartBlock({
    sessionId,
    timestamp: startTime,
    command: displayCommand,
  })
);
console.log('');  // Empty line after start block
```

Then the child process output goes directly to stdout. The issue is that for quick commands like `echo "hi"`, the output appears but there's no visual separation.

### 2. Inconsistent Formatting Across Modes

The isolation modes (screen, tmux, docker) have different output patterns:
- Screen attached mode uses log capture with `process.stdout.write(output)`
- Direct mode uses `child.stdout.pipe(process.stdout)` essentially
- Different approaches lead to different visual outputs

### 3. Truncated Data in Blocks

The `padText()` function in `output-blocks.js` truncates text to fit width:
```javascript
function padText(text, width) {
  if (text.length >= width) {
    return text.substring(0, width);  // Truncates!
  }
  return text + ' '.repeat(width - text.length);
}
```

This causes long paths to be cut off, making them non-copyable.

### 4. No Unified Template

Each execution mode builds its own output formatting, leading to inconsistencies.

## Proposed Solutions

### Solution 1: Fix `padText()` to Not Truncate Important Data

For important fields like `Log:` paths and `Session ID:`, we should allow text to overflow rather than truncate.

### Solution 2: Add Empty Lines Consistently

Ensure there's always an empty line:
- After the start block
- Before the finish block

### Solution 3: Create Unified Output Template

Create a single execution wrapper that all modes use:
1. Print start block
2. Print empty line
3. Execute command (output appears)
4. Print empty line
5. Print finish block

### Solution 4: Add Integration Tests

Create tests that verify `echo "hi"` works in:
- No isolation mode
- Screen isolation (attached and detached)
- Docker isolation (attached)
- Tmux isolation (attached and detached)

## Implementation Plan

1. **Update `output-blocks.js`**: Don't truncate important fields
2. **Update `cli.js`**: Ensure consistent empty lines
3. **Update `isolation.js`**: Align output handling
4. **Mirror changes in Rust**: Update `output_blocks.rs` and `main.rs`
5. **Add tests**: Create `echo-hi-integration.test.js`
6. **Update CI**: Ensure tests run on all isolation types available

## Files to Modify

### JavaScript
- `js/src/lib/output-blocks.js` - Fix truncation, improve formatting
- `js/src/bin/cli.js` - Ensure consistent output pattern
- `js/src/lib/isolation.js` - Align output handling
- `js/test/echo-integration.test.js` (new) - Integration tests

### Rust
- `rust/src/lib/output_blocks.rs` - Mirror JS changes
- `rust/src/bin/main.rs` - Ensure consistent output pattern

## Test Plan

The tests will verify:
1. `$ echo "hi"` produces output "hi" with start and finish blocks
2. Start block contains: Session ID, timestamp, command
3. Finish block contains: exit code, log path (full), session ID, duration
4. Empty lines exist before and after command output
5. Log path is fully copyable (not truncated)
