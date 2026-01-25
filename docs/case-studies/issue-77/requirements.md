# Requirements Analysis for Issue #77

## Functional Requirements

### FR1: Multi-Level Isolation Stacking

**Requirement:** Support specifying multiple isolation environments in a single `--isolated` argument.

**Syntax:**
```bash
$ --isolated "screen ssh tmux ssh docker" -- command
```

**Behavior:**
- Parse space-separated sequence of isolation backends
- Execute command through each level in sequence
- Each level wraps the next level's execution

### FR2: Per-Level Option Distribution

**Requirement:** Support specifying options (like `--image`, `--endpoint`) for specific levels in the stack.

**Syntax with placeholders:**
```bash
# Custom image only for the 5th (docker) level
$ --isolated "screen ssh tmux ssh docker" --image "_ _ _ _ oven/bun:latest" -- command

# SSH endpoints for levels 2 and 4
$ --isolated "screen ssh tmux ssh docker" --endpoint "_ user@server1 _ user@server2 _" -- command
```

**Placeholder semantics:**
- `_` (underscore) means "use default" or "not applicable" for that level
- Non-underscore values apply to corresponding levels

### FR3: Recursive Execution

**Requirement:** Each isolation level should call `$` with remaining levels.

**Example transformation:**
```bash
# Original command
$ --isolated "screen ssh tmux ssh docker" --image "_ _ _ _ oven/bun:latest" -- npm test

# Level 1 (screen) executes:
$ --isolated "ssh tmux ssh docker" --image "_ _ _ oven/bun:latest" -- npm test

# Level 2 (ssh) executes:
$ --isolated "tmux ssh docker" --image "_ _ oven/bun:latest" -- npm test

# Level 3 (tmux) executes:
$ --isolated "ssh docker" --image "_ oven/bun:latest" -- npm test

# Level 4 (ssh) executes:
$ --isolated "docker" --image "oven/bun:latest" -- npm test

# Level 5 (docker) executes:
npm test
```

### FR4: Timeline Visualization

**Requirement:** Show execution timeline that traces through all isolation levels.

**Example output:**
```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│ isolation screen → ssh → tmux → ssh → docker
│
$ npm test
<output>

✓
│ finish    2024-01-15 10:30:52
│ duration  7.456s
│ exit      0
```

### FR5: Backward Compatibility

**Requirement:** Existing single-level isolation commands must continue to work unchanged.

**Verification:**
```bash
# These must work exactly as before
$ --isolated screen -- echo hello
$ --isolated docker --image ubuntu:22.04 -- npm test
$ --isolated ssh --endpoint user@host -- ls
```

## Non-Functional Requirements

### NFR1: Links Notation Parsing

Use Links Notation for parsing sequences, providing a consistent syntax with other link-foundation projects.

### NFR2: Error Handling

- Validate that stacked environments make sense (e.g., can't have docker inside docker without special configuration)
- Provide clear error messages for invalid sequences
- Handle connection failures at any level gracefully

### NFR3: Performance

- Minimal overhead for single-level isolation (backward compatibility)
- Efficient parsing of multi-level specifications

## Options Analysis

See [options-analysis.md](./options-analysis.md) for detailed analysis of which options need stacking support.
