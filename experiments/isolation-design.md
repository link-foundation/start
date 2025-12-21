# Isolation Support Design

## Overview

This document outlines the design for adding process isolation support to start-command.

## Supported Isolation Backends

### Terminal Multiplexers

1. **screen** - GNU Screen, classic session manager
2. **tmux** - Modern terminal multiplexer
3. **zellij** - Modern, user-friendly multiplexer

### Container Isolation

4. **docker** - Docker containers

## Command Syntax

Two syntax patterns are supported:

```bash
# Pattern 1: Using -- separator
$ [wrapper-options] -- [command] [command-options]

# Pattern 2: Options before command
$ [wrapper-options] command [command-options]
```

### Wrapper Options

- `--isolated <backend>` or `-i <backend>`: Run command in isolated environment
  - Backends: `screen`, `tmux`, `docker`, `zellij`
- `--attached` or `-a`: Run in attached mode (foreground)
- `--detached` or `-d`: Run in detached mode (background)
- `--session <name>` or `-s <name>`: Name for the session (optional)

### Examples

```bash
# Run in tmux (attached by default for multiplexers)
$ --isolated tmux -- npm test

# Run in screen detached
$ --isolated screen --detached -- npm start

# Run in docker container
$ --isolated docker --image node:20 -- npm install

# Short form
$ -i tmux -d npm start
```

## Mode Behavior

### Attached Mode (--attached)

- Default for terminal multiplexers (screen, tmux, zellij)
- Command runs in foreground
- User can interact with the terminal
- For docker: runs with -it flags

### Detached Mode (--detached)

- Command runs in background
- For multiplexers: creates a session that can be reattached later
- For docker: runs with -d flag
- Session info is printed for later access

### Error Handling

- If both --attached and --detached are specified, throw an error
- Error message should ask user to choose only one

## Implementation Details

### Session Naming

- Auto-generate session name: `start-{timestamp}-{random}`
- Allow custom name via --session option
- Session names used for reattachment

### Backend Commands

#### Screen

```bash
# Attached
screen -S <session> bash -c '<command>'

# Detached
screen -dmS <session> bash -c '<command>'
```

#### Tmux

```bash
# Attached
tmux new-session -s <session> '<command>'

# Detached
tmux new-session -d -s <session> '<command>'
```

#### Zellij

```bash
# Attached
zellij run -- <command>

# Detached (via layout file or action)
zellij -s <session> action new-pane -- <command>
```

#### Docker

```bash
# Attached
docker run -it --name <name> <image> <command>

# Detached
docker run -d --name <name> <image> <command>
```

## Testing Strategy

### Unit Tests

- Argument parsing tests
- Backend detection tests
- Session name generation tests
- Conflict detection (attached + detached)

### Integration Tests

- Actual execution with mocked backends
- End-to-end tests with real backends (when available)

### E2E Tests

- Full workflow tests with screen/tmux (if installed)
