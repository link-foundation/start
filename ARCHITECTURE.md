# Architecture

This document describes the architecture of the `$` command (start-command).

## Overview

The start-command is a CLI tool that wraps shell commands to provide automatic logging, error reporting, natural language aliases, and process isolation capabilities.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Command                                 │
│                    $ [options] command [args]                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         CLI Entry Point                              │
│                        src/bin/cli.js                                │
├─────────────────────────────────────────────────────────────────────┤
│  • Parse command line arguments                                      │
│  • Handle --version, --help flags                                    │
│  • Route to isolation or direct execution                           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
              ▼                                 ▼
┌─────────────────────────┐      ┌─────────────────────────────────────┐
│   Direct Execution      │      │     Isolated Execution              │
│   (no --isolated)       │      │     (--isolated screen/tmux/docker) │
├─────────────────────────┤      ├─────────────────────────────────────┤
│ • Spawn shell process   │      │ src/lib/isolation.js                │
│ • Capture stdout/stderr │      │ • runInScreen()                     │
│ • Log to temp file      │      │ • runInTmux()                       │
│ • Report failures       │      │ • runInDocker()                     │
└─────────────────────────┘      └─────────────────────────────────────┘
```

## Core Modules

### 1. CLI Entry Point (`src/bin/cli.js`)

The main entry point that:

- Parses command line arguments using `args-parser.js`
- Processes command substitutions using `substitution.js`
- Routes execution to direct mode or isolation mode
- Handles logging and error reporting

### 2. Argument Parser (`src/lib/args-parser.js`)

Parses wrapper options and extracts the command to execute:

```javascript
{
  isolated: null,     // 'screen' | 'tmux' | 'docker' | null
  attached: false,    // Run in attached/foreground mode
  detached: false,    // Run in detached/background mode
  session: null,      // Custom session name
  image: null,        // Docker image name
  keepAlive: false,   // Keep environment alive after command exits
}
```

### 3. Substitution Engine (`src/lib/substitution.js`)

Provides natural language command aliases:

- Loads patterns from `substitutions.lino`
- Matches user input against patterns with variables
- Returns substituted command or original if no match

### 4. Isolation Module (`src/lib/isolation.js`)

Handles process isolation in terminal multiplexers and containers:

```
┌────────────────────────────────────────────────────────────┐
│                    runIsolated()                            │
│              (dispatcher function)                          │
└───────────────┬───────────────┬───────────────┬────────────┘
                │               │               │
        ┌───────▼───────┐ ┌─────▼─────┐ ┌───────▼───────┐
        │  runInScreen  │ │runInTmux  │ │ runInDocker   │
        │               │ │           │ │               │
        │ GNU Screen    │ │ tmux      │ │ Docker        │
        │ multiplexer   │ │ terminal  │ │ containers    │
        └───────────────┘ └───────────┘ └───────────────┘
```

## Isolation Architecture

### Execution Modes

| Mode         | Description                                 | Default Behavior               |
| ------------ | ------------------------------------------- | ------------------------------ |
| Attached     | Command runs in foreground, interactive     | Session exits after completion |
| Detached     | Command runs in background                  | Session exits after completion |
| + Keep-Alive | Session stays alive after command completes | Requires `--keep-alive` flag   |

### Auto-Exit Behavior

By default, all isolation environments automatically exit after command completion:

```
┌───────────────────────────────────────────────────────────────┐
│                    Default (keepAlive=false)                  │
├───────────────────────────────────────────────────────────────┤
│  1. Start isolation environment                               │
│  2. Execute command                                           │
│  3. Capture output (if attached mode)                         │
│  4. Environment exits automatically                           │
│  5. Resources freed                                           │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│                    With --keep-alive                          │
├───────────────────────────────────────────────────────────────┤
│  1. Start isolation environment                               │
│  2. Execute command                                           │
│  3. Command completes                                         │
│  4. Shell stays running in session                           │
│  5. User can reattach and interact                           │
└───────────────────────────────────────────────────────────────┘
```

### Screen Isolation

```
┌─────────────────────────────────────────────────────────────────┐
│                     Screen Execution Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Attached Mode:                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Uses detached mode with log capture internally           │    │
│  │ • Start: screen -dmS <session> -L -Logfile <log>        │    │
│  │ • Poll for session completion                            │    │
│  │ • Read and display captured output                       │    │
│  │ • Clean up log file                                      │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Detached Mode:                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • Without keep-alive: screen -dmS <session> sh -c cmd   │    │
│  │ • With keep-alive: screen -dmS <session> sh -c "cmd; sh"│    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### tmux Isolation

```
┌─────────────────────────────────────────────────────────────────┐
│                      tmux Execution Flow                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Attached Mode:                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • tmux new-session -s <session> <command>               │    │
│  │ • Interactive, exits when command completes             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Detached Mode:                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • Without keep-alive: tmux new-session -d -s <session>  │    │
│  │ • With keep-alive: command followed by shell exec       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Docker Isolation

```
┌─────────────────────────────────────────────────────────────────┐
│                     Docker Execution Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Attached Mode:                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • docker run -it --rm --name <name> <image> sh -c cmd   │    │
│  │ • Interactive, container auto-removed on exit           │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Detached Mode:                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ • Without keep-alive: docker run -d --name <name> ...   │    │
│  │ • With keep-alive: command followed by shell exec       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Logging Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Logging Flow                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────────┐   │
│  │ Command     │───▶│ Capture      │───▶│ Write to          │   │
│  │ Execution   │    │ stdout/stderr│    │ Temp Log File     │   │
│  └─────────────┘    └──────────────┘    └───────────────────┘   │
│                                                                  │
│  Log File Format:                                                │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ === Start Command Log ===                                │    │
│  │ Timestamp: 2024-01-15 10:30:45                          │    │
│  │ Command: <command>                                       │    │
│  │ Shell: /bin/bash                                        │    │
│  │ Platform: linux                                          │    │
│  │ ==================================================      │    │
│  │ <command output>                                         │    │
│  │ ==================================================      │    │
│  │ Finished: 2024-01-15 10:30:46                           │    │
│  │ Exit Code: 0                                             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
start-command/
├── src/
│   ├── bin/
│   │   └── cli.js              # Main entry point
│   └── lib/
│       ├── args-parser.js      # Argument parsing
│       ├── isolation.js        # Isolation backends
│       ├── substitution.js     # Command aliases
│       └── substitutions.lino  # Alias patterns
├── test/
│   ├── cli.test.js            # CLI tests
│   ├── isolation.test.js      # Isolation tests
│   ├── args-parser.test.js    # Parser tests
│   └── substitution.test.js   # Substitution tests
├── docs/
│   ├── PIPES.md               # Piping documentation
│   └── USAGE.md               # Usage examples
├── experiments/               # Experimental scripts
├── REQUIREMENTS.md            # Requirements specification
├── ARCHITECTURE.md            # This file
└── README.md                  # Project overview
```

## Design Decisions

### 1. Auto-Exit by Default

All isolation environments exit automatically after command completion to:

- Prevent resource leaks from orphaned sessions
- Ensure consistent behavior across backends
- Match user expectations for command execution

### 2. Log Capture in Attached Screen Mode

Screen's attached mode uses internal detached mode with log capture because:

- Direct attached mode loses output for quick commands
- Screen's virtual terminal is destroyed before output is visible
- Log capture ensures reliable output preservation

### 3. Keep-Alive as Opt-In

The `--keep-alive` flag is disabled by default because:

- Most use cases don't require persistent sessions
- Prevents accidental resource consumption
- Explicit opt-in for advanced workflows

### 4. Uniform Backend Interface

All isolation backends share a consistent interface:

```javascript
async function runInBackend(command, options) {
  return {
    success: boolean,
    sessionName: string,
    message: string,
    exitCode?: number,
    output?: string
  };
}
```

This enables:

- Easy addition of new backends
- Consistent error handling
- Unified logging format
