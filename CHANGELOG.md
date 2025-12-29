# start-command

## 0.13.0

### Minor Changes

- 7763ae1: Use command-stream library for command execution in CLI

  This update integrates the command-stream library to handle command execution, replacing direct usage of execSync and spawnSync in the main CLI flow. The change provides a more consistent API for running shell commands and better output handling.

  Key changes:
  - Added command-stream as a dependency
  - Created a wrapper module for async command execution utilities
  - Refactored printVersion(), runDirect(), and detectRepository() to use command-stream
  - Converted main CLI flow to async for proper integration

## 0.11.0

### Minor Changes

- 1240a29: Add SSH isolation support for remote command execution.
  - Implements SSH backend for executing commands on remote servers via SSH, similar to screen/tmux/docker isolation
  - Uses `--endpoint` option to specify SSH target (e.g., `--endpoint user@remote.server`)
  - Supports both attached (interactive) and detached (background) modes
  - Includes comprehensive SSH integration tests in CI with a local SSH server

## 0.10.0

### Minor Changes

- 8ea5659: Add user isolation support with --isolated-user and --keep-user options

  Implements user isolation that creates a new isolated user to run commands:

  ## --isolated-user option (create isolated user with same permissions)
  - Add --isolated-user, -u option to create a new isolated user automatically
  - New user inherits group memberships from current user (sudo, docker, wheel, etc.)
  - User is automatically deleted after command completes (unless --keep-user)
  - Works with screen and tmux isolation backends (not docker)
  - Optional custom username via --isolated-user=myname or -u myname
  - For screen/tmux: Wraps commands with sudo -n -u <user>
  - Requires sudo NOPASSWD configuration for useradd/userdel/sudo

  ## --keep-user option
  - Add --keep-user option to prevent user deletion after command completes
  - Useful when you need to inspect files created during execution
  - User must be manually deleted with: sudo userdel -r <username>

  ## Other improvements
  - Add comprehensive tests for user isolation
  - Update documentation with user isolation examples
  - Integrate --keep-alive and --auto-remove-docker-container from main branch

  Usage:
  - $ --isolated-user -- npm test # Auto-generated username, auto-deleted
  - $ --isolated-user myrunner -- npm start # Custom username
  - $ -u myrunner -- npm start # Short form
  - $ --isolated screen --isolated-user -- npm test # Combine with process isolation
  - $ --isolated-user --keep-user -- npm test # Keep user after completion

  Note: User isolation requires sudo NOPASSWD configuration.

## 0.9.0

### Minor Changes

- c484149: Add --keep-alive option for isolation environments
  - All isolation environments (screen, tmux, docker) now automatically exit after command completion by default
  - New --keep-alive (-k) flag keeps the isolation environment running after command completes
  - Add ARCHITECTURE.md documentation describing system design
  - Update REQUIREMENTS.md with new option and auto-exit behavior documentation

## 0.7.6

### Patch Changes

- a5fca3f: Add documentation for piping with `$` command
  - Created `docs/PIPES.md` with detailed guide on pipe usage
  - Preferred approach: `echo "hi" | $ agent` (pipe TO the $-wrapped command)
  - Alternative approach: `$ 'echo "hi" | agent'` (quoting)
  - Updated `docs/USAGE.md` with brief pipe reference
  - Updated `README.md` with piping examples
  - Updated case study for issue #28 with new recommended approach

## 0.7.5

### Patch Changes

- 31a67fc: fix: Screen isolation output always captured in attached mode

  Changed attached mode to always use log capture instead of direct screen invocation.
  This ensures command output is never lost, even for quick commands that would
  otherwise have their output disappear when the screen session terminates rapidly.

  Fixes #25: Output from `$ --isolated screen -- echo "hello"` is now properly
  displayed instead of being lost with only "[screen is terminating]" shown.

## 0.7.4

### Patch Changes

- d058c43: fix: Screen isolation output not captured for quoted commands

  This fixes issue #25 where commands with quoted strings (e.g., echo "hello") would not show their output when using screen isolation. The fix uses spawnSync with array arguments instead of execSync with a constructed string to avoid shell quoting issues.

## 0.7.2

### Patch Changes

- fa0fb23: docs: Update documentation to Bun-first approach
  - Remove npm installation option from README.md
  - Update examples to use bun commands instead of npm
  - Change package.json engines from node to bun
  - Update REQUIREMENTS.md to remove Node.js alternative

## 0.7.1

### Patch Changes

- d5a7c66: Fix all --version detection issues
  - Fix screen version detection by capturing stderr
  - Show Bun version instead of Node.js version when running with Bun
  - Show macOS ProductVersion instead of kernel version
  - Fix argument parsing to handle `$ --version --` same as `$ --version`
  - Update all scripts and examples to use Bun instead of Node.js
  - Add comprehensive tests for --version flag

## 0.7.0

### Minor Changes

- 9e24fb5: Add --version flag to display comprehensive version and system information. Users can now run `$ --version` or `$ -v` to see the version of start-command, system details, and versions of isolation tools (screen, tmux, docker).

## 0.6.0

### Minor Changes

- 37eb93b: Drop zellij isolation backend support, focusing on screen, tmux, and docker. Remove zellij from VALID_BACKENDS, remove runInZellij function, and update all documentation accordingly.

## 0.5.3

### Patch Changes

- 20d0c1c: Fix screen isolation not capturing output on macOS (issue #15)
  - Added version detection for GNU Screen to handle differences between versions
  - Screen >= 4.5.1 uses native `-L -Logfile` for log capture
  - Screen < 4.5.1 (like macOS bundled 4.0.3) uses `tee` command fallback
  - Added tests for version detection and -Logfile support checking
  - Updated case study documentation with root cause analysis

## 0.5.2

### Patch Changes

- bdf77c7: Fix screen isolation environment not capturing command output in attached mode

  When running commands with `--isolated screen` in attached mode, the command output was not being displayed (only "screen is terminating" was shown). This was because GNU Screen requires a TTY to run in attached mode, which is not available when spawning from Node.js without a terminal.

  The fix implements a fallback mechanism that:
  - Checks if a TTY is available before spawning screen
  - If no TTY is available, uses detached mode with log capture to run the command and display its output
  - Polls for session completion and reads the captured log file
  - Displays the output to the user just as if it was running in attached mode

  This ensures that `$ --isolated screen -- echo "hello"` now correctly displays "hello" even when running from environments without a TTY (like CI/CD pipelines, scripts, or when piping output).

## 0.5.1

### Patch Changes

- Test patch release

## 0.5.0

### Minor Changes

- 95d8760: Unify output experience for isolation mode
  - Change terminology from "Backend" to "Environment" in isolation output
  - Add unified logging with timestamps for isolation modes (screen, tmux, docker, zellij)
  - Save log files for all execution modes with consistent format
  - Display start/end timestamps, exit code, and log file path uniformly across all modes

## 0.4.1

### Patch Changes

- 73635f9: Make it bun first - update shebangs and installation docs

## 0.4.0

### Minor Changes

- e8bec3c: Add process isolation support with --isolated option

  This release adds the ability to run commands in isolated environments:

  **New Features:**
  - `--isolated` / `-i` option to run commands in screen, tmux, zellij, or docker
  - `--attached` / `-a` and `--detached` / `-d` modes for foreground/background execution
  - `--session` / `-s` option for custom session names
  - `--image` option for Docker container image specification
  - Two command syntax patterns: `$ [options] -- [command]` or `$ [options] command`

  **Supported Backends:**
  - GNU Screen - classic terminal multiplexer
  - tmux - modern terminal multiplexer
  - zellij - modern terminal workspace
  - Docker - container isolation

  **Examples:**

  ```bash
  $ --isolated tmux -- npm start
  $ -i screen -d npm start
  $ --isolated docker --image node:20 -- npm install
  ```

## 0.3.1

### Patch Changes

- 6a701da: Apply js-ai-driven-development-pipeline-template (Bun-only)
  - Add .changeset/ for version management
  - Add .husky/ for git hooks
  - Add eslint.config.mjs with ESLint 9 flat config
  - Add .prettierrc for code formatting
  - Add bunfig.toml for Bun configuration
  - Add scripts/ directory with release automation scripts
  - Create release.yml workflow (Bun-only, merged test.yml)
  - Add CHANGELOG.md

## 0.3.0

### Minor Changes

- Initial release with natural language command aliases
- Automatic logging of all commands
- Auto-reporting on failure for NPM packages
- GitHub integration for issue creation
