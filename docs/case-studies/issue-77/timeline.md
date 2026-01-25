# Timeline Visualization for Isolation Stacking

## Current Timeline Output

For single-level isolation, the current output looks like:

```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│
$ npm test
<command output>

✓
│ finish    2024-01-15 10:30:52
│ duration  7.456s
│ exit      0
│
│ log       /tmp/start-command-1705312245123-abc123.log
│ session   abc-123-def-456-ghi
```

## Proposed Timeline for Stacked Isolation

### Option A: Flat Timeline with Isolation Chain

Show the full isolation chain in metadata, but keep execution flat:

```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│ isolation screen → ssh@server1 → tmux → ssh@server2 → docker:ubuntu
│
$ npm test
<command output>

✓
│ finish    2024-01-15 10:30:52
│ duration  7.456s
│ exit      0
│
│ log       /tmp/start-command-1705312245123-abc123.log
│ session   abc-123-def-456-ghi
```

**Pros:**
- Clean, simple output
- Easy to understand at a glance
- No additional complexity in output handling

**Cons:**
- Doesn't show timing per level
- Can't see where failures occurred in the chain

### Option B: Nested Timeline with Indentation

Show each level's entry and exit:

```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│
│ → screen (session: myscreen)
│   → ssh (endpoint: user@server1)
│     → tmux (session: mytmux)
│       → ssh (endpoint: user@server2)
│         → docker (image: ubuntu:22.04)
│
$ npm test
<command output>

✓
│         ← docker (exit: 0, duration: 1.234s)
│       ← ssh (exit: 0, duration: 1.456s)
│     ← tmux (exit: 0, duration: 1.678s)
│   ← ssh (exit: 0, duration: 2.123s)
│ ← screen (exit: 0, duration: 2.345s)
│
│ finish    2024-01-15 10:30:52
│ duration  7.456s
│ exit      0
│
│ session   abc-123-def-456-ghi
```

**Pros:**
- Detailed visibility into each level
- Shows exactly where time is spent
- Clear failure point identification

**Cons:**
- More verbose output
- More complex implementation
- May be overwhelming for deep stacks

### Option C: Compact Entry with Detailed Exit

Show simple entry, detailed exit:

```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│ entering  screen → ssh → tmux → ssh → docker
│
$ npm test
<command output>

✓
│ exiting   docker ✓ → ssh ✓ → tmux ✓ → ssh ✓ → screen ✓
│ finish    2024-01-15 10:30:52
│ duration  7.456s (screen: 2.3s, ssh: 0.6s, tmux: 1.2s, ssh: 0.8s, docker: 2.5s)
│ exit      0
│
│ session   abc-123-def-456-ghi
```

**Pros:**
- Balanced verbosity
- Shows per-level timing without cluttering main output
- Clear success/failure indication per level

**Cons:**
- Complex formatting logic
- Duration breakdown may be imprecise

## Recommendation

**Start with Option A (Flat Timeline)** for initial implementation:
- Simplest to implement
- Maintains backward compatibility in output format
- Add `isolation` metadata field showing the chain

Later, can add `--verbose` or `--timeline-detail` flag to enable Option B or C.

## Implementation Notes

### Isolation Chain Formatting

```javascript
function formatIsolationChain(stack, options) {
  return stack.map((backend, i) => {
    let label = backend;
    if (backend === 'ssh' && options.endpoints[i]) {
      label = `ssh@${options.endpoints[i]}`;
    }
    if (backend === 'docker' && options.images[i]) {
      label = `docker:${options.images[i].split(':')[0]}`;
    }
    return label;
  }).join(' → ');
}
```

### Exit Status Aggregation

When unwinding the stack, collect exit codes:

```javascript
const results = {
  levels: [
    { backend: 'docker', exitCode: 0, duration: 1234 },
    { backend: 'ssh', exitCode: 0, duration: 1456 },
    { backend: 'tmux', exitCode: 0, duration: 1678 },
    { backend: 'ssh', exitCode: 0, duration: 2123 },
    { backend: 'screen', exitCode: 0, duration: 2345 },
  ],
  totalDuration: 7456,
  overallExitCode: 0,
};
```

### Failure Handling

If any level fails, show the failure point:

```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│ isolation screen → ssh@server1 → tmux → ssh@server2 → docker:ubuntu
│

✗
│ failed    ssh@server2 (connection refused)
│ finish    2024-01-15 10:30:47
│ duration  2.123s
│ exit      255
│
│ session   abc-123-def-456-ghi
```

## Virtual Commands

When entering each level, we may want to show the "virtual command" being executed:

```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│
$ [screen] entering isolation
$ [ssh] connecting to user@server1
$ [tmux] entering isolation
$ [ssh] connecting to user@server2
$ [docker] starting container ubuntu:22.04
$ npm test
<command output>

✓
│ finish    2024-01-15 10:30:52
```

This aligns with existing virtual command visualization for Docker image pulls.
