# Options Analysis for Isolation Stacking

## Current Wrapper Options

Based on the current implementation in `args-parser.js`:

| Option | Current Usage | Stack Support Needed | Notes |
|--------|--------------|---------------------|-------|
| `--isolated, -i` | Single backend | **Primary target** | Becomes sequence |
| `--attached, -a` | Boolean flag | No | Global setting |
| `--detached, -d` | Boolean flag | No | Global setting |
| `--session, -s` | Session name | Maybe | Could be per-level |
| `--session-id` | UUID tracking | No | Global tracking |
| `--image` | Docker image | **Yes** | Only applies to docker levels |
| `--endpoint` | SSH target | **Yes** | Only applies to ssh levels |
| `--isolated-user, -u` | Username | Maybe | Per-level or global |
| `--keep-user` | Boolean flag | No | Global setting |
| `--keep-alive, -k` | Boolean flag | Maybe | Could be per-level |
| `--auto-remove-docker-container` | Boolean flag | Maybe | Per docker level |
| `--use-command-stream` | Boolean flag | No | Global experimental |
| `--status` | UUID query | N/A | Query mode, not execution |
| `--output-format` | Format string | N/A | Query mode |
| `--cleanup` | Boolean flag | N/A | Cleanup mode |

## Options Requiring Stacking Support

### 1. `--isolated` (Primary)

**Current:** Single value from `[screen, tmux, docker, ssh]`

**Proposed:** Space-separated sequence parsed with Links Notation

```bash
--isolated "screen ssh tmux ssh docker"
```

**Parsing:**
```javascript
// Single value (backward compatible)
"docker" → ["docker"]

// Multiple values
"screen ssh docker" → ["screen", "ssh", "docker"]
```

### 2. `--image`

**Current:** Single Docker image name

**Proposed:** Space-separated sequence with `_` placeholders

```bash
--image "_ _ _ _ oven/bun:latest"  # 5-level stack, only last is docker
--image "ubuntu:22.04"             # Single value applies to all docker levels
```

**Parsing:**
```javascript
// Single value (applies to all docker levels)
"ubuntu:22.04" → ["ubuntu:22.04"] // replicate for each docker level

// Sequence with placeholders
"_ _ ubuntu:22.04" → [null, null, "ubuntu:22.04"]
```

### 3. `--endpoint`

**Current:** Single SSH endpoint (user@host)

**Proposed:** Space-separated sequence with `_` placeholders

```bash
--endpoint "_ user@server1 _ user@server2 _"  # SSH at levels 2 and 4
--endpoint "user@host"                          # Single value for all SSH levels
```

**Parsing:**
```javascript
// Single value (applies to all ssh levels)
"user@host" → ["user@host"]

// Sequence with placeholders
"_ user@host1 _ user@host2" → [null, "user@host1", null, "user@host2"]
```

## Options with Optional Stacking Support

### 4. `--session`

Could support per-level session names:

```bash
--session "myscreen _ mytmux _ mycontainer"
```

**Recommendation:** Keep simple for now, auto-generate per-level names.

### 5. `--keep-alive`

Could be per-level:

```bash
--keep-alive "true _ true _ false"
```

**Recommendation:** Keep as global flag for simplicity. When set, applies to all levels.

### 6. `--auto-remove-docker-container`

Could be per docker level:

```bash
--auto-remove-docker-container "true false"  # For two docker levels
```

**Recommendation:** Keep as global flag for simplicity.

## Validation Rules for Stacked Options

### Rule 1: Length Matching

When both `--isolated` and option sequences are provided, lengths should match:

```bash
# Valid: 5 isolation levels, 5 image specs (using _ for non-docker)
--isolated "screen ssh tmux ssh docker" --image "_ _ _ _ ubuntu:22.04"

# Invalid: Mismatched lengths
--isolated "screen ssh docker" --image "_ _ ubuntu:22.04 ubuntu:24.04"  # 3 vs 4
```

### Rule 2: Type Compatibility

Options should only have non-placeholder values for compatible isolation types:

```bash
# Valid: --image only has value for docker level (5th)
--isolated "screen ssh tmux ssh docker" --image "_ _ _ _ ubuntu:22.04"

# Warning/Error: --image has value for non-docker level
--isolated "screen ssh tmux ssh docker" --image "ubuntu:22.04 _ _ _ _"  # screen doesn't use image
```

### Rule 3: Required Options

SSH isolation still requires endpoint, Docker still works with default image:

```bash
# Error: SSH level 2 missing endpoint
--isolated "screen ssh docker" --endpoint "_ _ _"

# Valid: SSH level 2 has endpoint
--isolated "screen ssh docker" --endpoint "_ user@host _"
```

## Implementation Considerations

### Parsing Strategy

1. Check if value contains spaces
2. If spaces: parse as Links Notation sequence
3. If no spaces: treat as single value (backward compatible)

### Default Value Handling

- For single values: replicate to match isolation stack length
- For sequences with `_`: substitute defaults at runtime

### Error Messages

Provide clear feedback for configuration errors:

```
Error: Isolation stack has 5 levels but --image has 3 values
  --isolated "screen ssh tmux ssh docker"
  --image "_ _ ubuntu:22.04"

  Consider: --image "_ _ _ _ ubuntu:22.04" (5 values to match isolation levels)
```
