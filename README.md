# start-command (`$`)

Gamification of coding - execute any command with automatic logging and ability to auto-report issues on GitHub.

## Installation

Install using [Bun](https://bun.sh):

```bash
bun install -g start-command
```

## Usage

The `$` command acts as a wrapper for any shell command:

```bash
$ ls -la
$ cat file.txt
$ npm test
$ git status
```

### Piping with `$`

When piping data to a command wrapped with `$`, **put `$` on the receiving command**:

```bash
# Preferred - pipe TO the $-wrapped command
echo "hi" | $ agent

# Alternative - quote the entire pipeline (more verbose)
$ 'echo "hi" | agent'
```

Both approaches work, but piping TO `$` is simpler and requires fewer quotes.

```bash
# More examples
cat file.txt | $ processor
git diff | $ reviewer
echo "analyze this" | $ agent --verbose
```

See [docs/PIPES.md](docs/PIPES.md) for detailed guidance on piping, and [docs/USAGE.md](docs/USAGE.md) for general usage.

### Natural Language Commands (Aliases)

You can also use natural language to execute common commands. The `$` command supports pattern-based substitutions defined in `substitutions.lino`:

```bash
# Install NPM packages
$ install lodash npm package                    # -> npm install lodash
$ install 4.17.21 version of lodash npm package # -> npm install lodash@4.17.21
$ install lodash npm package globally           # -> npm install -g lodash

# Clone repositories
$ clone https://github.com/user/repo repository # -> git clone https://github.com/user/repo

# Git operations
$ checkout main branch                          # -> git checkout main
$ create feature-x branch                       # -> git checkout -b feature-x

# Common operations
$ list files                                    # -> ls -la
$ show current directory                        # -> pwd
$ create my-project directory                   # -> mkdir -p my-project

# Python packages
$ install requests python package               # -> pip install requests
```

If no pattern matches, the command is executed as-is.

## Features

### Natural Language Aliases (Links Notation)

Commands can be expressed in plain English using patterns defined in `substitutions.lino`. This file uses [Links Notation](https://github.com/link-foundation/links-notation) style patterns with variables.

Each pattern is defined as a doublet link - a pair of pattern and replacement wrapped in parentheses:

```
# Pattern definition in substitutions.lino:
(
  install $packageName npm package
  npm install $packageName
)

# Usage:
$ install express npm package
# Executes: npm install express
```

Variables like `$packageName`, `$version`, `$repository` are captured and used in the substitution.

### Automatic Logging

All command output is automatically saved to your system's temporary directory. Output uses a "status spine" format with clear visual distinction:

```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│
$ npm test

... command output ...

✓
│ finish    2024-01-15 10:30:52
│ duration  7.456s
│ exit      0
│
│ log       /tmp/start-command-1705312245123-abc123.log
│ session   abc-123-def-456-ghi
```

The `│` prefix indicates tool metadata, `$` shows the executed command, and `✓`/`✗` indicates success/failure.

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
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│
$ some-npm-tool --broken-arg

... error output ...

✗
│ finish    2024-01-15 10:30:46
│ duration  1.789s
│ exit      1
│
│ log       /tmp/start-command-1705312246789-def456.log
│ session   abc-123-def-456-ghi

Detected repository: https://github.com/owner/some-npm-tool
Log uploaded: https://gist.github.com/user/abc123
Issue created: https://github.com/owner/some-npm-tool/issues/42
```

### Process Isolation

Run commands in isolated environments using terminal multiplexers, containers, or remote servers:

```bash
# Run in tmux (attached by default)
$ --isolated tmux -- bun start

# Run in screen detached
$ --isolated screen --detached -- bun start

# Run in docker container
$ --isolated docker --image oven/bun:latest -- bun install

# Run on remote server via SSH
$ --isolated ssh --endpoint user@remote.server -- npm test

# Short form with custom session name
$ -i tmux -s my-session -d bun start
```

### User Isolation

Create a new isolated user with the same group permissions as your current user to run commands in complete isolation:

```bash
# Create an isolated user with same permissions and run command
$ --isolated-user -- npm test

# Specify custom username for the isolated user
$ --isolated-user myrunner -- npm start
$ -u myrunner -- npm start

# Combine with process isolation (screen or tmux)
$ --isolated screen --isolated-user -- npm test

# Keep the user after command completes (don't delete)
$ --isolated-user --keep-user -- npm start

# The isolated user inherits your group memberships:
# - sudo group (if you have it)
# - docker group (if you have it)
# - wheel, admin, and other privileged groups
```

The `--isolated-user` option:

- Creates a new system user with the same group memberships as your current user
- Runs the command as that user
- Automatically deletes the user after the command completes (unless `--keep-user` is specified)
- Requires sudo access without password (NOPASSWD configuration)
- Works with screen and tmux isolation backends (not docker)

This is useful for:

- Running untrusted code in isolation
- Testing with a clean user environment
- Ensuring commands don't affect your user's files

#### Supported Backends

| Backend  | Description                                    | Installation                                               |
| -------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `screen` | GNU Screen terminal multiplexer                | `apt install screen` / `brew install screen`               |
| `tmux`   | Modern terminal multiplexer                    | `apt install tmux` / `brew install tmux`                   |
| `docker` | Container isolation (requires --image)         | [Docker Installation](https://docs.docker.com/get-docker/) |
| `ssh`    | Remote execution via SSH (requires --endpoint) | `apt install openssh-client` / `brew install openssh`      |

#### Isolation Options

| Option                           | Description                                               |
| -------------------------------- | --------------------------------------------------------- |
| `--isolated, -i`                 | Isolation backend (screen, tmux, docker, ssh)             |
| `--attached, -a`                 | Run in attached/foreground mode (default)                 |
| `--detached, -d`                 | Run in detached/background mode                           |
| `--session, -s`                  | Custom session/container name                             |
| `--image`                        | Docker image (required for docker isolation)              |
| `--endpoint`                     | SSH endpoint (required for ssh, e.g., user@host)          |
| `--isolated-user, -u [name]`     | Create isolated user with same permissions (screen/tmux)  |
| `--keep-user`                    | Keep isolated user after command completes (don't delete) |
| `--keep-alive, -k`               | Keep session alive after command completes                |
| `--auto-remove-docker-container` | Auto-remove docker container after exit (docker only)     |

**Note:** Using both `--attached` and `--detached` together will result in an error - you must choose one mode.

#### Auto-Exit Behavior

By default, all isolation environments (screen, tmux, docker) automatically exit after the target command completes. This ensures resources are freed immediately and provides uniform behavior across all backends.

Use `--keep-alive` (`-k`) to keep the session running after command completion:

```bash
# Default: session exits after command completes
$ -i screen -d -- echo "hello"
# Session will exit automatically after command completes.

# With --keep-alive: session stays running for interaction
$ -i screen -d -k -- echo "hello"
# Session will stay alive after command completes.
# You can reattach with: screen -r <session-name>
```

For Docker containers, by default the container filesystem is preserved (appears in `docker ps -a`) so you can re-enter it later. Use `--auto-remove-docker-container` to remove the container immediately after exit.

### Graceful Degradation

The tool works in any environment:

- **No `gh` CLI?** - Logs are still saved locally, auto-reporting is skipped
- **No `gh-upload-log`?** - Issue can still be created with local log reference
- **Repository not detected?** - Command runs normally with logging
- **No permission to create issue?** - Skipped with a clear message
- **Isolation backend not installed?** - Clear error message with installation instructions

## Requirements

### Required

- [Bun](https://bun.sh) >= 1.0.0

### Optional (for full auto-reporting)

- [GitHub CLI (`gh`)](https://cli.github.com/) - For authentication and issue creation
- [gh-upload-log](https://github.com/link-foundation/gh-upload-log) - For uploading log files

To set up auto-reporting:

```bash
# Install GitHub CLI and authenticate
gh auth login

# Install log uploader
bun install -g gh-upload-log
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

| Variable                      | Description                                                    |
| ----------------------------- | -------------------------------------------------------------- |
| `START_DISABLE_AUTO_ISSUE`    | Set to `1` or `true` to disable automatic issue creation       |
| `START_DISABLE_LOG_UPLOAD`    | Set to `1` or `true` to disable log upload                     |
| `START_LOG_DIR`               | Custom directory for log files (defaults to OS temp directory) |
| `START_VERBOSE`               | Set to `1` or `true` for verbose output                        |
| `START_DISABLE_SUBSTITUTIONS` | Set to `1` or `true` to disable pattern matching/aliases       |
| `START_SUBSTITUTIONS_PATH`    | Custom path to substitutions.lino file                         |

Example:

```bash
# Run without auto-issue creation
START_DISABLE_AUTO_ISSUE=1 $ bun test

# Use custom log directory
START_LOG_DIR=./logs $ bun test

# Disable substitutions (use raw command)
START_DISABLE_SUBSTITUTIONS=1 $ install lodash npm package

# Use custom substitutions file
START_SUBSTITUTIONS_PATH=/path/to/my-rules.lino $ install mypackage npm package
```

### Custom Substitutions

You can create your own substitution patterns by placing a `substitutions.lino` file in `~/.start-command/substitutions.lino`. User patterns take precedence over the default ones.

## Log File Format

Log files are saved as `start-command-{timestamp}-{random}.log` and contain the command output along with metadata. The console output uses a "status spine" format:

```
│ session   abc-123-def-456-ghi
│ start     2024-01-15 10:30:45
│
$ bun test

... command output ...

✓
│ finish    2024-01-15 10:30:52
│ duration  7.456s
│ exit      0
│
│ log       /tmp/start-command-1705312245123-abc123.log
│ session   abc-123-def-456-ghi
```

The log file itself contains the raw command output and execution metadata.

## License

MIT
