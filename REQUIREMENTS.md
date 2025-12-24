# Requirements for `$` Command (start-command)

## Overview

The `$` command is a CLI tool that wraps any shell command and provides automatic logging, error reporting, issue creation capabilities, and natural language command aliases.

## Core Requirements

### 1. Command Proxy Functionality

- Act as a transparent proxy for any shell command
- Pass all arguments directly to the underlying shell (bash/powershell/sh)
- Support all standard commands: `$ ls`, `$ cat`, `$ mkdir`, etc.
- Preserve exit codes from wrapped commands
- Support natural language command aliases via pattern matching

### 2. Logging Requirements

#### 2.1 Log Storage

- Save full command output (stdout + stderr) to temporary OS directory
- Use platform-appropriate temp directory:
  - Linux/macOS: `/tmp/` or `os.tmpdir()`
  - Windows: `%TEMP%`
- Log file naming: `start-command-{timestamp}-{random}.log`

#### 2.2 Log Content

- Include timestamp at the start of logging
- Include timestamp at the end of logging
- Capture both stdout and stderr
- Store the complete command that was executed
- Store the exit code

#### 2.3 Log Display

- Print full log content to console after command finishes
- Always print the exit code (success or failure)
- Make exit code prominent as "it may usually be unclear"

### 3. Repository Detection

#### 3.1 NPM Package Detection

- Detect if the executed command is a globally installed NPM package
- Use `which` (Unix) or `where` (Windows) to find command location
- Check if command resolves to a path within npm global modules
- Extract package name from the path
- Use `npm view <package> repository.url` to get repository URL

#### 3.2 Supported Command Types

- Globally installed NPM packages (primary focus)
- Future: other package managers (pip, gem, etc.)

### 4. Automatic Issue Reporting (On Failure)

#### 4.1 Preconditions for Auto-Reporting

- Command must have failed (non-zero exit code)
- Repository must be detected for the command
- `gh` CLI tool must be authenticated
- User must have permission to create issues in target repository

#### 4.2 Log Upload

- Use `gh-upload-log` tool to upload the log file
- Upload as a gist (for logs ≤100MB)
- Print the uploaded log URL to console

#### 4.3 Issue Creation

- Create an issue in the detected repository
- Issue title: Include command name and error summary
- Issue body: Include:
  - Command that was executed
  - Exit code
  - Link to uploaded log
  - System information (OS, Bun/Node.js version)
  - Timestamp
- Print the created issue URL to console

### 5. Graceful Degradation

#### 5.1 When Repository Cannot Be Detected

- Still log everything to temp directory
- Still print logs and exit code to console
- Skip log upload and issue creation

#### 5.2 When `gh` Is Not Authenticated

- Still log everything to temp directory
- Still print logs and exit code to console
- Print a message that auto-reporting is skipped
- Skip log upload and issue creation

#### 5.3 When `gh-upload-log` Is Not Installed

- Still log everything to temp directory
- Still print logs and exit code to console
- Print a message that log upload is skipped
- Skip issue creation (no log link available)

### 5. Command Aliases / Substitutions

#### 5.1 Pattern Matching

- Support natural language patterns defined in `substitutions.lino`
- Use Links Notation style with variables like `$packageName`, `$version`
- Match input against patterns and substitute with actual commands
- More specific patterns (more variables, longer patterns) take precedence
- Non-matching commands pass through unchanged

#### 5.2 Built-in Patterns

- NPM: `install $packageName npm package` -> `npm install $packageName`
- NPM with version: `install $version version of $packageName npm package` -> `npm install $packageName@$version`
- Git clone: `clone $repository repository` -> `git clone $repository`
- Git checkout: `checkout $branch branch` -> `git checkout $branch`
- Common operations: `list files` -> `ls -la`, `show current directory` -> `pwd`

#### 5.3 Custom Patterns

- Support user-defined patterns in `~/.start-command/substitutions.lino`
- User patterns take precedence over built-in patterns
- Support custom path via `START_SUBSTITUTIONS_PATH` environment variable

### 6. Process Isolation

#### 6.1 Command Syntax

Support two patterns for passing wrapper options:

- `$ [wrapper-options] -- [command] [command-options]` (explicit separator)
- `$ [wrapper-options] command [command-options]` (options before command)

#### 6.2 Isolation Options

- `--isolated, -i <backend>`: Run command in isolated environment
- `--attached, -a`: Run in attached/foreground mode (default)
- `--detached, -d`: Run in detached/background mode
- `--session, -s <name>`: Custom session name
- `--image <image>`: Docker image (required for docker backend)
- `--keep-alive, -k`: Keep isolation environment alive after command exits (disabled by default)

#### 6.3 Supported Backends

- `screen`: GNU Screen terminal multiplexer
- `tmux`: tmux terminal multiplexer
- `docker`: Docker containers (requires --image option)

#### 6.4 Mode Behavior

- **Attached mode**: Command runs in foreground, user can interact
- **Detached mode**: Command runs in background, session info displayed for reattachment
- **Conflict handling**: If both --attached and --detached are specified, show error asking user to choose one

#### 6.5 Auto-Exit Behavior

By default, all isolation environments (screen, tmux, docker) automatically exit after the target command completes execution. This ensures:

- Resources are freed immediately after command execution
- No orphaned sessions/containers remain running
- Uniform behavior across all isolation backends
- Command output is still captured and logged before exit

The `--keep-alive` flag can be used to override this behavior and keep the isolation environment running after command completion, useful for debugging or interactive workflows.

#### 6.6 Graceful Degradation

- If isolation backend is not installed, show informative error with installation instructions
- If session creation fails, report error with details

## Configuration Options

- `START_DISABLE_AUTO_ISSUE`: Disable automatic issue creation
- `START_DISABLE_LOG_UPLOAD`: Disable log upload
- `START_LOG_DIR`: Custom log directory
- `START_VERBOSE`: Enable verbose output
- `START_DISABLE_SUBSTITUTIONS`: Disable pattern matching/aliases
- `START_SUBSTITUTIONS_PATH`: Custom path to substitutions file

## Output Format

### Success Case

```
[2024-01-15 10:30:45] Starting: ls -la
... command output ...
[2024-01-15 10:30:45] Finished
Exit code: 0
Log saved: /tmp/start-command-1705312245-abc123.log
```

### Failure Case (With Auto-Reporting)

```
[2024-01-15 10:30:45] Starting: failing-npm-command --arg
... command output/error ...
[2024-01-15 10:30:46] Finished
Exit code: 1
Log saved: /tmp/start-command-1705312246-def456.log
Detected repository: https://github.com/owner/repo
Log uploaded: https://gist.github.com/...
Issue created: https://github.com/owner/repo/issues/123
```

### Failure Case (Without Auto-Reporting)

```
[2024-01-15 10:30:45] Starting: unknown-command
... command output/error ...
[2024-01-15 10:30:45] Finished
Exit code: 127
Log saved: /tmp/start-command-1705312245-ghi789.log
Repository not detected - automatic issue creation skipped
```

## Dependencies

### Required

- **Bun >= 1.0.0** (primary runtime)
- `child_process` (built-in)
- `os` (built-in)
- `fs` (built-in)
- `path` (built-in)

### Optional (for full functionality)

- `gh` CLI - GitHub CLI for authentication and issue creation
- `gh-upload-log` - For uploading log files to GitHub

## Security Considerations

- Do not include sensitive environment variables in logs
- Do not include authentication tokens in issue reports
- Respect `.gitignore` patterns when detecting repositories
- Only create issues in public repositories unless explicitly authorized
