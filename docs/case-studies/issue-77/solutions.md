# Solution Proposals for Issue #77

## Solution Overview

This document proposes implementation approaches for the isolation stacking feature.

## Proposed Solution: Recursive Self-Invocation

### Architecture

The core approach is **recursive self-invocation**: each isolation level calls `$` with one less level in the stack.

```
┌─────────────────────────────────────────────────────────────────┐
│ Level 0: Original Command                                       │
│ $ --isolated "screen ssh tmux ssh docker" --image "...img..." npm test
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Level 1: Screen Session                                         │
│ $ --isolated "ssh tmux ssh docker" --image "...img..." npm test │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Level 2: SSH Connection to server1                              │
│ $ --isolated "tmux ssh docker" --image "..img.." npm test       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Level 3: tmux Session                                           │
│ $ --isolated "ssh docker" --image ".img." npm test              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Level 4: SSH Connection to server2                              │
│ $ --isolated "docker" --image "img" npm test                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Level 5: Docker Container                                       │
│ npm test                                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. Sequence Parser (`lib/sequence-parser.js`)

```javascript
/**
 * Parse a space-separated sequence with underscore placeholders
 * @param {string} value - Space-separated values (e.g., "screen ssh docker")
 * @returns {string[]} Array of values or null for placeholders
 */
function parseSequence(value) {
  if (!value || !value.includes(' ')) {
    // Single value - backward compatible
    return [value];
  }

  return value.split(/\s+/).map(v => v === '_' ? null : v);
}

/**
 * Shift sequence by removing first element
 * @param {string[]} sequence - Parsed sequence
 * @returns {string} New sequence string
 */
function shiftSequence(sequence) {
  const remaining = sequence.slice(1);
  return remaining.map(v => v === null ? '_' : v).join(' ');
}

/**
 * Distribute option values across isolation levels
 * @param {string} optionValue - Space-separated or single value
 * @param {number} stackDepth - Number of isolation levels
 * @returns {string[]} Array of values for each level
 */
function distributeOption(optionValue, stackDepth) {
  const parsed = parseSequence(optionValue);

  if (parsed.length === 1 && stackDepth > 1) {
    // Single value: replicate for all levels
    return Array(stackDepth).fill(parsed[0]);
  }

  // Validate length matches stack depth
  if (parsed.length !== stackDepth) {
    throw new Error(
      `Option has ${parsed.length} values but isolation stack has ${stackDepth} levels`
    );
  }

  return parsed;
}
```

#### 2. Updated Args Parser

Modify `args-parser.js` to handle sequences:

```javascript
// In parseOption function, update --isolated handling:
if (arg === '--isolated' || arg === '-i') {
  if (index + 1 < args.length && !args[index + 1].startsWith('-')) {
    const value = args[index + 1];

    // Check for sequence (contains spaces)
    if (value.includes(' ')) {
      // Parse as sequence
      const backends = value.split(/\s+/).filter(Boolean);
      options.isolated = backends[0];  // Current level
      options.isolatedStack = backends;  // Full stack
    } else {
      options.isolated = value.toLowerCase();
      options.isolatedStack = [value.toLowerCase()];
    }
    return 2;
  }
  // ... error handling
}

// Similar updates for --image and --endpoint to store arrays
```

#### 3. Command Builder

New module to construct recursive commands:

```javascript
/**
 * Build command for next isolation level
 * @param {object} options - Current wrapper options
 * @param {string} command - User command to execute
 * @returns {string} Command to execute at current level
 */
function buildNextLevelCommand(options, command) {
  if (options.isolatedStack.length <= 1) {
    // Last level - execute actual command
    return command;
  }

  const parts = ['$'];

  // Remaining isolation stack
  const remainingStack = options.isolatedStack.slice(1);
  parts.push(`--isolated "${remainingStack.join(' ')}"`);

  // Shift option values
  if (options.imageStack && options.imageStack.length > 1) {
    const remainingImages = options.imageStack.slice(1);
    parts.push(`--image "${remainingImages.map(v => v || '_').join(' ')}"`);
  }

  if (options.endpointStack && options.endpointStack.length > 1) {
    const remainingEndpoints = options.endpointStack.slice(1);
    parts.push(`--endpoint "${remainingEndpoints.map(v => v || '_').join(' ')}"`);
  }

  // Pass through global flags
  if (options.detached) parts.push('--detached');
  if (options.keepAlive) parts.push('--keep-alive');
  if (options.sessionId) parts.push(`--session-id ${options.sessionId}`);

  // Separator and command
  parts.push('--', command);

  return parts.join(' ');
}
```

#### 4. Updated Isolation Runner

Modify `isolation.js` to use command builder:

```javascript
async function runIsolated(backend, command, options = {}) {
  // Build the command to execute at this level
  const effectiveCommand = options.isolatedStack?.length > 1
    ? buildNextLevelCommand(options, command)
    : command;

  switch (backend) {
    case 'screen':
      return runInScreen(effectiveCommand, {
        ...options,
        session: options.sessionStack?.[0] || options.session,
      });
    case 'tmux':
      return runInTmux(effectiveCommand, {
        ...options,
        session: options.sessionStack?.[0] || options.session,
      });
    case 'docker':
      return runInDocker(effectiveCommand, {
        ...options,
        image: options.imageStack?.[0] || options.image,
      });
    case 'ssh':
      return runInSsh(effectiveCommand, {
        ...options,
        endpoint: options.endpointStack?.[0] || options.endpoint,
      });
    default:
      return Promise.resolve({
        success: false,
        message: `Unknown isolation environment: ${backend}`,
      });
  }
}
```

### Validation Rules

```javascript
function validateIsolationStack(options) {
  const stack = options.isolatedStack || [options.isolated];

  // Validate each backend
  for (const backend of stack) {
    if (!VALID_BACKENDS.includes(backend)) {
      throw new Error(
        `Invalid isolation environment: "${backend}". Valid options are: ${VALID_BACKENDS.join(', ')}`
      );
    }
  }

  // Check SSH levels have endpoints
  const sshCount = stack.filter(b => b === 'ssh').length;
  const endpointCount = (options.endpointStack || []).filter(v => v !== null).length;

  if (sshCount > 0 && endpointCount === 0) {
    throw new Error(
      `Stack contains ${sshCount} SSH level(s) but no --endpoint specified`
    );
  }

  // Warn if option counts don't match (non-fatal)
  if (options.imageStack && options.imageStack.length !== stack.length) {
    console.warn(
      `Warning: --image has ${options.imageStack.length} values but stack has ${stack.length} levels`
    );
  }

  // Check depth limit
  const MAX_DEPTH = 7;
  if (stack.length > MAX_DEPTH) {
    throw new Error(
      `Isolation stack too deep: ${stack.length} levels (max: ${MAX_DEPTH})`
    );
  }
}
```

### Timeline Integration

Update `output-blocks.js` to show isolation chain:

```javascript
function createStartBlock(params) {
  let content = '';
  content += `│ session   ${params.sessionId}\n`;
  content += `│ start     ${params.startTime}\n`;

  // Show isolation chain if stacked
  if (params.isolatedStack && params.isolatedStack.length > 1) {
    const chain = formatIsolationChain(params.isolatedStack, params);
    content += `│ isolation ${chain}\n`;
  }

  content += '│\n';
  return content;
}

function formatIsolationChain(stack, params) {
  return stack.map((backend, i) => {
    if (backend === 'ssh' && params.endpointStack?.[i]) {
      return `ssh@${params.endpointStack[i]}`;
    }
    if (backend === 'docker' && params.imageStack?.[i]) {
      const imageName = params.imageStack[i].split(':')[0].split('/').pop();
      return `docker:${imageName}`;
    }
    return backend;
  }).join(' → ');
}
```

## Alternative Solutions

### Alternative A: Single-Pass Deep Nesting

Instead of recursive self-invocation, build the entire nested command at once:

```bash
screen -dmS session sh -c "ssh user@host 'tmux new -d -s session sh -c \"docker run ubuntu sh -c \\\"npm test\\\"\"'"
```

**Pros:**
- Single command execution
- No dependency on `$` being available at each level

**Cons:**
- Extremely complex quoting/escaping
- Harder to debug
- Difficult to capture output at each level
- Doesn't support `$` features (logging, tracking) at intermediate levels

**Recommendation:** Not recommended due to complexity.

### Alternative B: Agent-Based Execution

Deploy a lightweight agent at each level that receives commands via stdin or sockets:

**Pros:**
- More control over execution
- Better error reporting

**Cons:**
- Requires agent installation
- More complex infrastructure
- Overkill for this use case

**Recommendation:** Out of scope for current requirements.

## Implementation Plan

### Phase 1: Core Parsing (Minimum Viable)
1. Add sequence parser utility
2. Update `--isolated` parsing for sequences
3. Add `isolatedStack` to options
4. Validate single-backend case still works

### Phase 2: Option Distribution
1. Add sequence parsing for `--image`
2. Add sequence parsing for `--endpoint`
3. Validate option/stack length matching
4. Add validation rules

### Phase 3: Command Building
1. Implement `buildNextLevelCommand`
2. Update isolation runners to use it
3. Test 2-level stacking
4. Test 5-level stacking

### Phase 4: Timeline Integration
1. Add `isolation` field to timeline
2. Format isolation chain
3. Update logging

### Phase 5: Testing & Documentation
1. Unit tests for parser
2. Integration tests for stacking
3. Update README
4. Update ARCHITECTURE.md

## Testing Strategy

### Unit Tests

```javascript
describe('Sequence Parser', () => {
  it('should parse single value', () => {
    expect(parseSequence('docker')).toEqual(['docker']);
  });

  it('should parse space-separated sequence', () => {
    expect(parseSequence('screen ssh docker')).toEqual(['screen', 'ssh', 'docker']);
  });

  it('should handle underscore placeholders', () => {
    expect(parseSequence('_ ssh _ docker')).toEqual([null, 'ssh', null, 'docker']);
  });
});

describe('Command Builder', () => {
  it('should build next level command', () => {
    const options = {
      isolatedStack: ['screen', 'ssh', 'docker'],
      imageStack: [null, null, 'ubuntu:22.04'],
      endpointStack: [null, 'user@host', null],
    };
    const result = buildNextLevelCommand(options, 'npm test');
    expect(result).toBe('$ --isolated "ssh docker" --image "_ ubuntu:22.04" --endpoint "user@host _" -- npm test');
  });
});
```

### Integration Tests

```javascript
describe('Isolation Stacking', () => {
  it('should execute command through screen → docker', async () => {
    const result = await executeWithStacking(
      '--isolated "screen docker" --image "_ alpine" -- echo hello',
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello');
  });
});
```

## Dependencies

### Existing Dependencies
- `links-notation` (via `lino-objects-codec`) - Could use for advanced parsing

### New Dependencies
- None required for basic implementation

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Infinite recursion | Depth limit (MAX_DEPTH = 7) |
| `$` not available in remote | Document requirement, add check |
| SSH connection failures | Timeout handling, clear error messages |
| Complex escaping issues | Use array args instead of string concatenation |
| Backward compatibility | Extensive testing of single-level cases |
