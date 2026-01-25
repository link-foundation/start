# Case Study: Isolation Environment Stacking (Issue #77)

## Overview

This case study analyzes the implementation of stacking/queuing multiple isolation environments in sequence for the start-command CLI tool.

## Problem Statement

Currently, start-command supports running commands in a single isolation environment:
- `--isolated screen` - Run in GNU Screen
- `--isolated tmux` - Run in tmux
- `--isolated docker` - Run in Docker container
- `--isolated ssh` - Run via SSH on remote server

The request is to support **stacking** multiple isolation environments in sequence:

```bash
$ --isolated "screen ssh tmux ssh docker" -- npm test
```

This would create a nested execution environment where:
1. Start in a screen session
2. SSH to a remote server
3. Start a tmux session on that server
4. SSH to another server
5. Run in a Docker container

## Related Documents

- [Requirements Analysis](./requirements.md) - Detailed analysis of all requirements
- [Options Analysis](./options-analysis.md) - Analysis of options that need stacking support
- [Solution Proposals](./solutions.md) - Proposed implementation approaches
- [Timeline Visualization](./timeline.md) - Execution timeline considerations
- [Research Findings](./research.md) - External research and related tools

## Key Concepts

### Links Notation
The sequence syntax is based on [Links Notation](https://github.com/link-foundation/links-notation), a format for representing structured data through references and links.

### Underscore Placeholder
The underscore (`_`) serves as a placeholder for "default" or "skip this level":

```bash
--image "_ _ _ _ oven/bun:latest"  # Only 5th level uses custom image
--endpoint "_ user@server1 _ user@server2 _"  # SSH endpoints for levels 2 and 4
```

## Implementation Summary

See [solutions.md](./solutions.md) for detailed implementation proposals.
