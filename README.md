# start-command (`$`)

[![JavaScript CI/CD](https://github.com/link-foundation/start/actions/workflows/js.yml/badge.svg)](https://github.com/link-foundation/start/actions/workflows/js.yml)
[![Rust CI/CD](https://github.com/link-foundation/start/actions/workflows/rust.yml/badge.svg)](https://github.com/link-foundation/start/actions/workflows/rust.yml)
[![npm version](https://img.shields.io/npm/v/start-command?label=npm&style=flat)](https://www.npmjs.com/package/start-command)
[![Crates.io](https://img.shields.io/crates/v/start-command?label=crates.io&style=flat)](https://crates.io/crates/start-command)
[![License: Unlicense](https://img.shields.io/badge/license-Unlicense-blue.svg)](LICENSE)

Gamification of coding - execute any command with automatic logging and ability to auto-report issues on GitHub.

This repository contains two implementations that share the same behaviour and
documentation:

- **[JavaScript / Bun](js/README.md)** — published to [npm](https://www.npmjs.com/package/start-command); release tags `js-v<version>`, titles `[JavaScript] <version>`.
- **[Rust](rust/README.md)** — published to [crates.io](https://crates.io/crates/start-command); release tags `rust-v<version>`, titles `[Rust] <version>`.

## Installation

Install using [Bun](https://bun.sh):

```bash
bun install -g start-command
```

Or install the Rust version:

```bash
cargo install start-command
```

## Usage

The `$` command acts as a wrapper for any shell command:

```bash
$ echo "Hello World"
$ ls -la
$ cat file.txt
$ bun test
$ git status
```

Quoted arguments keep their boundaries, so `$ node -e "console.log('hi')"` and
`$ git commit -m "msg with spaces"` reach the command exactly as typed. A single
quoted argument is still run as a shell script (`$ 'cat file.txt | grep x'`).
See [docs/USAGE.md](docs/USAGE.md#argument-boundaries) for details.

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

See [docs/PIPES.md](docs/PIPES.md) for detailed guidance on piping,
[docs/USAGE.md](docs/USAGE.md) for general usage, and
[docs/EXAMPLES.md](docs/EXAMPLES.md) for examples checked against the
JavaScript and Rust CLIs.

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

All command output is automatically saved to your system's temporary directory. Output uses a "timeline" format with clear visual distinction:

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
│ log       /tmp/start-command/logs/direct/abc-123-def-456-ghi.log
│ session   abc-123-def-456-ghi
```

The `│` prefix indicates tool metadata, `$` shows the executed command, and `✓`/`✗` indicates success/failure.

### Execution Tracking

Every command gets an execution record that can be queried later:

```bash
# Show one execution by UUID or isolation session name
$ --status abc-123-def-456-ghi

# List all stored executions, newest first
$ --list

# Machine-readable list output
$ --list --output-format json

# Only the executions that are still running
$ --list --running

# Upload the stored log for one execution
$ --upload-log 29d6c026-b168-44a6-8a3f-c3919c7e5327

# Ask a detached isolated execution to stop gracefully
$ --stop 29d6c026-b168-44a6-8a3f-c3919c7e5327

# Terminate a detached isolated execution immediately
$ --terminate 29d6c026-b168-44a6-8a3f-c3919c7e5327

# Re-enter a running detached session
$ --attach my-docker-session

# Follow its output without sending input
$ --attach my-docker-session --read-only

# Restart the stored command in the same environment
$ --resume my-docker-session

# Run a different command in the same container filesystem
$ --resume my-docker-session -- bash

# Re-attach or reconcile every execution still marked running
$ --resume-all
```

`--status` and `--list` default to Links Notation. Both also support
`--output-format json` and `--output-format text`. Status and list output
include best-effort `processIds` for tracked wrapper processes and detached
screen, tmux, and Docker isolation containers when those native tools can
report them.

For detached Docker executions, `oomKilled` is reported as an observation of the
container cgroup flag, not as a verdict: while `docker inspect` still reports the
container as running the status stays `executing`, and once it stops the reported
`exitCode` is the container's real exit code. `137` is only used as a fallback
when the container is gone and neither a stored exit code nor a log footer can be
recovered.

`--upload-log` accepts either an execution UUID or an isolation session name. It
looks up the stored `logPath`, installs `gh-upload-log` with Bun or npm if the
uploader is missing, and then streams the uploader output directly.

`--stop` and `--terminate` accept either the execution UUID or the isolation
session/container name. `--stop` asks the backend to stop gracefully (CTRL+C for
screen/tmux, `docker stop` for Docker). `--terminate` uses the backend's
immediate termination command.

#### Re-entering, continuing and repairing sessions

`--attach`, `--resume` and `--resume-all` accept the same identifiers as
`--status`: an execution UUID or an isolation session name.

`--attach <id>` re-enters a **running** detached session — `docker attach`,
`screen -r`, or `tmux attach-session`. Add `--read-only` to follow the output
without sending input (`docker logs -f`, `tmux attach-session -r`, or a log
tail). If the session is already gone, `--attach` says so and points at
`--resume` instead of leaving you with a `docker exec` command that cannot work
on a stopped container.

`--resume <id>` continues a **stopped** detached execution:

| Session state                       | What happens                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Container exists, no new command    | `docker start` re-runs the stored command in the same container.                                         |
| Container exists, new command given | The container filesystem is committed to an image and a derived container runs the new command.          |
| Session is gone                     | The command is launched again through the stored isolation options (same image, volumes, env, networks). |

`--resume <id> -- <command>` is the form downstream tools need: it runs a
_different_ command against the same container filesystem, instead of
`docker start -ai`, which would re-run the original entrypoint from scratch.

A resume keeps the original execution UUID, so `--status`, `--list` and
`--upload-log` keep addressing one logical session across restarts. The previous
session name is remembered in `sessionNameHistory` and still resolves to the
same record.

`--resume-all` repairs state after the supervisor host restarts, which kills the
detached completion watcher while the container keeps running. Each execution
still marked running is reported with one of four actions:

| Action       | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `reattached` | A live Docker container got a fresh completion watcher.                     |
| `running`    | A live screen/tmux session needs nothing; its logging is in-session.        |
| `reconciled` | The session is gone, so the record was finalized from its exit code/footer. |
| `unknown`    | The backend cannot be probed locally (ssh); the record is left untouched.   |

`--resume-all` never silently restarts work: continuing a command is always an
explicit, per-session decision made with `--resume`. Use `--list --running` as
the machine-readable set that drives it.

#### Exit reason hints

A bare `exitCode 139` with `oomKilled false` hides the real cause. When the
stored log contains a fatal memory marker such as
`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`,
`--status` adds a hint:

```
Exit Reason:       memory-exhaustion (v8-heap-limit)
Memory Exhausted:  true
Memory Evidence:   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

`memoryExhausted` answers the narrower question consumers of `oomKilled` are
really asking - did this run die of memory exhaustion? - and
`memoryExhaustedReason` carries the log line that proves it. A runtime that
aborts on its own heap limit dies *below* the container limit, so the kernel
never OOM-kills anything and `State.OOMKilled` stays `false`; the only evidence
is what the dying runtime printed into the log. Both fields appear only for a
non-zero exit code, so a command that merely *prints* such a marker and then
succeeds is never reported as a memory failure.

The same tail is scanned for attached and detached sessions alike, with a 64 KiB
window, because V8 prints a long native stack trace after the marker.

`exitReason`, `memoryExhausted` and `memoryExhaustedReason` are only hints. They
never change `status`, `exitCode` or `oomKilled`, which stay observations of what
the backend actually reported.

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
│ log       /tmp/start-command/logs/direct/abc-123-def-456-ghi.log
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
$ --isolated docker -- echo "hello from docker"

# Run a Bun command in the link-foundation/box JavaScript image
$ --isolated docker --image ghcr.io/link-foundation/box-js:latest -- bun --version

# Run a multi-runtime AI coding experiment in the full box image
$ --isolated docker --image ghcr.io/link-foundation/box:latest -- bash -lc 'node --version && python --version && rustc --version'

# Mount tool credentials and pass environment variables into the container
$ -i docker --image konard/hive-mind-dind:latest \
    -v ~/.config/gh:/root/.config/gh \
    -v ~/.claude:/root/.claude \
    -e GH_TOKEN=$GH_TOKEN -- gh repo list

# Run a Docker-in-Docker image in privileged mode
$ -i docker --image konard/hive-mind-dind:latest --privileged -- solve <issue-url>

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
- Works with screen and tmux isolation environments (not docker)

This is useful for:

- Running untrusted code in isolation
- Testing with a clean user environment
- Ensuring commands don't affect your user's files

#### Supported Isolation Environments

| Environment | Description                                              | Installation                                               |
| ----------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `screen`    | GNU Screen terminal multiplexer                          | `apt install screen` / `brew install screen`               |
| `tmux`      | Modern terminal multiplexer                              | `apt install tmux` / `brew install tmux`                   |
| `docker`    | Container isolation (uses a default image, or `--image`) | [Docker Installation](https://docs.docker.com/get-docker/) |
| `ssh`       | Remote execution via SSH (requires --endpoint)           | `apt install openssh-client` / `brew install openssh`      |

#### Isolation Options

| Option                           | Description                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `--isolated, --isolation, -i`    | Isolation environment (screen, tmux, docker, ssh)                            |
| `--attached, -a`                 | Run in attached/foreground mode (default)                                    |
| `--detached, -d`                 | Run in detached/background mode                                              |
| `--session, -s`                  | Custom session/container name                                                |
| `--image`                        | Docker image (optional; defaults to OS-matched image)                        |
| `--volume, -v`                   | Docker bind mount/volume `host:container[:mode]` (repeatable, docker only)   |
| `--mount`                        | Docker `--mount` spec (repeatable, docker only)                              |
| `--env, -e`                      | Environment variable `KEY=VALUE` for the container (repeatable, docker only) |
| `--privileged`                   | Run docker container in privileged mode (docker only)                        |
| `--network`                      | Connect to a named network (repeatable, docker only)                         |
| `--network-alias`                | Add an alias on the first network (repeatable, docker only)                  |
| `--endpoint`                     | SSH endpoint (required for ssh, e.g., user@host)                             |
| `--isolated-user, -u [name]`     | Create isolated user with same permissions (screen/tmux)                     |
| `--keep-user`                    | Keep isolated user after command completes (don't delete)                    |
| `--keep-alive, -k`               | Keep session alive after command completes                                   |
| `--auto-remove-docker-container` | Always remove docker container after exit (docker only)                      |
| `--always-cleanup-container`     | Always remove docker container after exit (docker only)                      |
| `--keep-container`               | Keep docker container filesystem after exit (docker only)                    |
| `--keep-container-on-fail`       | Keep failed or OOM-killed docker containers after exit (docker only)         |

**Note:** Using both `--attached` and `--detached` together will result in an error - you must choose one mode.

When `--network` is repeated, Docker creates the container on the first network,
connects every additional network, and only then starts the command. This lets a
container retain egress through one network while reaching services on a private
network without a startup race. Repeated `--network-alias` values apply to the
first network.

```bash
$ --isolated docker --image alpine:3.23 \
    --network bridge --network my-sidecar-net -- ping -c 1 sidecar
```

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

For Docker containers, successful runs are removed by default. Failed containers, including containers Docker reports as `OOMKilled`, are kept for investigation and include a `docker rm -f <container>` cleanup hint. Use `--always-cleanup-container` or `--auto-remove-docker-container` to force removal after exit, or `--keep-container` to preserve the container filesystem after every run.

### Graceful Degradation

The tool works in any environment:

- **No `gh` CLI?** - Logs are still saved locally, auto-reporting is skipped
- **No `gh-upload-log` during auto-reporting?** - Issue can still be created with local log reference
- **No `gh-upload-log` during manual `--upload-log`?** - The uploader is installed on demand
- **Repository not detected?** - Command runs normally with logging
- **No permission to create issue?** - Skipped with a clear message
- **Isolation environment not installed?** - Clear error message with installation instructions

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

Log files are saved under `/tmp/start-command/logs/` by default and contain the command output along with metadata. When an execution UUID is available, the log path is stable, for example `/tmp/start-command/logs/direct/<uuid>.log` or `/tmp/start-command/logs/isolation/screen/<uuid>.log`. The console output uses a "timeline" format:

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
│ log       /tmp/start-command/logs/direct/abc-123-def-456-ghi.log
│ session   abc-123-def-456-ghi
```

The log file itself contains the raw command output and execution metadata.

## License

[Unlicense](LICENSE) (public domain)

This project is released into the public domain under the Unlicense. It has fewer restrictions and more freedoms than MIT — especially for commercial use. You can copy, modify, publish, use, compile, sell, or distribute this software without any conditions or attribution requirements.
