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
│  Console Output Format (Timeline):                           │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ │ session   abc-123-def-456                              │    │
│  │ │ start     2024-01-15 10:30:45                          │    │
│  │ │                                                        │    │
│  │ $ <command>                                              │    │
│  │                                                          │    │
│  │ <command output>                                         │    │
│  │                                                          │    │
│  │ ✓ (or ✗ for failure)                                     │    │
│  │ │ finish    2024-01-15 10:30:46                          │    │
│  │ │ duration  1.234s                                       │    │
│  │ │ exit      0                                            │    │
│  │ │                                                        │    │
│  │ │ log       /tmp/start-command-123.log                   │    │
│  │ │ session   abc-123-def-456                              │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Format key:                                                     │
│  - │ prefix → tool metadata                                      │
│  - $ prefix → executed command                                   │
│  - No prefix → program output (stdout/stderr)                    │
│  - ✓ / ✗ → result marker (success/failure)                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Dual-Language Implementation

The `$` command is maintained in two languages that must stay in sync:

### JavaScript Implementation (`js/`)

Primary runtime version using Bun/Node.js:

```
js/
├── src/
│   ├── bin/
│   │   └── cli.js                  # Main entry point
│   └── lib/
│       ├── args-parser.js          # Argument parsing
│       ├── isolation.js            # Isolation backends (screen/tmux/docker/ssh)
│       ├── substitution.js         # Command aliases
│       ├── execution-store.js      # Execution tracking and history
│       ├── output-blocks.js        # Timeline format output rendering
│       ├── user-manager.js         # User creation/deletion
│       ├── failure-handler.js      # Automatic GitHub issue creation
│       ├── status-formatter.js     # Execution status querying
│       ├── sequence-parser.js      # Isolation stacking sequence parsing
│       └── substitutions.lino      # Alias patterns
├── test/                           # 500+ test cases
└── package.json
```

### Rust Implementation (`rust/`)

Performance-optimized alternative:

```
rust/
├── src/
│   ├── bin/
│   │   └── main.rs                 # Main entry point
│   └── lib/
│       ├── args_parser.rs          # Argument parsing
│       ├── isolation.rs            # Isolation backends (screen/tmux/docker/ssh)
│       ├── substitution.rs         # Command aliases
│       ├── execution_store.rs      # Execution tracking and history
│       ├── output_blocks.rs        # Timeline format output rendering
│       ├── user_manager.rs         # User creation/deletion
│       ├── failure_handler.rs      # Automatic GitHub issue creation
│       ├── status_formatter.rs     # Execution status querying
│       ├── sequence_parser.rs      # Isolation stacking sequence parsing
│       └── mod.rs                  # Module exports
├── tests/                          # 450+ test cases
└── Cargo.toml
```

### Sync Requirements

Both implementations must:

1. **Support the same CLI flags and behavior** — any new option added to one must be added to the other
2. **Have equivalent test coverage** — CI/CD fails if Rust has ≥10% fewer test cases than JavaScript
3. **Maintain 80% test coverage** — CI/CD fails if coverage drops below 80% in either implementation
4. **Share the same substitution patterns** — `substitutions.lino` is shared between both implementations

### Parity Check Script

The `scripts/check-test-parity.mjs` script counts test cases in both implementations and fails if the ratio drops below 90%:

```sh
node scripts/check-test-parity.mjs
```

## File Structure

```
start-command/
├── js/                        # JavaScript implementation
├── rust/                      # Rust implementation
├── lib/                       # Shared library (lino-objects-codec)
├── scripts/                   # CI/CD and release scripts
│   └── check-test-parity.mjs  # Rust/JS test count parity check
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
