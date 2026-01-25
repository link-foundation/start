---
'start-command': minor
---

feat: Add isolation stacking support

Added support for stacking multiple isolation environments in sequence,
allowing complex isolation chains like:

```bash
$ echo hi --isolated "screen ssh tmux docker"
```

Key features:

- Space-separated sequences for `--isolated`, `--image`, and `--endpoint` options
- Underscore (`_`) placeholder for "default/skip" values in option sequences
- Recursive execution where each level invokes `$` with remaining levels
- Maximum isolation depth of 7 levels (prevents infinite recursion)

Example usage:

```bash
# SSH to remote host, then run in Docker
$ cmd --isolated "ssh docker" --endpoint "user@host _" --image "_ node:20"

# Create screen session, SSH to host, start tmux, run in Docker
$ cmd --isolated "screen ssh tmux docker" --endpoint "_ user@host _ _" --image "_ _ _ node:20"
```

Backward compatible: All existing single-level isolation commands work unchanged.

Fixes #77
