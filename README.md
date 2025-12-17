# start-command (`$`)

Gamification of coding - execute any command with automatic logging and ability to auto-report issues on GitHub.

## Installation

```bash
npm install -g start-command
```

## Usage

The `$` command acts as a wrapper for any shell command:

```bash
$ ls -la
$ cat file.txt
$ npm test
$ git status
```

## Features

### Automatic Logging

All command output is automatically saved to your system's temporary directory with timestamps:

```
[2024-01-15 10:30:45.123] Starting: npm test
... command output ...
[2024-01-15 10:30:52.456] Finished
Exit code: 0
Log saved: /tmp/start-command-1705312245123-abc123.log
```

### Exit Code Display

The exit code is always prominently displayed after command completion, making it clear whether the command succeeded or failed.

### Auto-Reporting on Failure (NPM packages)

When a command fails (non-zero exit code) and it's a globally installed NPM package:

1. **Repository Detection** - Automatically detects the GitHub repository for NPM packages
2. **Log Upload** - Uploads the full log to GitHub (requires [gh-upload-log](https://github.com/link-foundation/gh-upload-log))
3. **Issue Creation** - Creates an issue in the package's repository with:
   - Command that was executed
   - Exit code
   - System information
   - Link to uploaded log

```
[2024-01-15 10:30:45.123] Starting: some-npm-tool --broken-arg
... error output ...
[2024-01-15 10:30:46.789] Finished
Exit code: 1
Log saved: /tmp/start-command-1705312246789-def456.log

Detected repository: https://github.com/owner/some-npm-tool
Log uploaded: https://gist.github.com/user/abc123
Issue created: https://github.com/owner/some-npm-tool/issues/42
```

### Graceful Degradation

The tool works in any environment:

- **No `gh` CLI?** - Logs are still saved locally, auto-reporting is skipped
- **No `gh-upload-log`?** - Issue can still be created with local log reference
- **Repository not detected?** - Command runs normally with logging
- **No permission to create issue?** - Skipped with a clear message

## Requirements

### Required
- Node.js >= 14.0.0

### Optional (for full auto-reporting)
- [GitHub CLI (`gh`)](https://cli.github.com/) - For authentication and issue creation
- [gh-upload-log](https://github.com/link-foundation/gh-upload-log) - For uploading log files

To set up auto-reporting:

```bash
# Install GitHub CLI and authenticate
gh auth login

# Install log uploader
npm install -g gh-upload-log
```

## How It Works

1. **Command Execution** - Your command is passed directly to the shell (bash/powershell/sh)
2. **Output Capture** - Both stdout and stderr are captured while still being displayed
3. **Log File** - Complete output is saved with timestamps and system info
4. **Failure Handling** - On non-zero exit:
   - Detects if the command is an NPM package
   - Looks up the package's GitHub repository
   - Uploads log (if `gh-upload-log` is available)
   - Creates an issue (if `gh` is authenticated and has permission)

## Configuration

The following environment variables can be used to customize behavior:

| Variable | Description |
|----------|-------------|
| `START_DISABLE_AUTO_ISSUE` | Set to `1` or `true` to disable automatic issue creation |
| `START_DISABLE_LOG_UPLOAD` | Set to `1` or `true` to disable log upload |
| `START_LOG_DIR` | Custom directory for log files (defaults to OS temp directory) |
| `START_VERBOSE` | Set to `1` or `true` for verbose output |

Example:
```bash
# Run without auto-issue creation
START_DISABLE_AUTO_ISSUE=1 $ npm test

# Use custom log directory
START_LOG_DIR=./logs $ npm test
```

## Log File Format

Log files are saved as `start-command-{timestamp}-{random}.log` and contain:

```
=== Start Command Log ===
Timestamp: 2024-01-15 10:30:45.123
Command: npm test
Shell: /bin/bash
Platform: linux
Node Version: v18.17.0
Working Directory: /home/user/project
==================================================

... command output ...

==================================================
Finished: 2024-01-15 10:30:52.456
Exit Code: 0
```

## License

MIT
