# Changelog

All notable changes to the Rust package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- changelog-insert-here -->
## [0.16.1] - 2026-06-17

Fixed detached `--status` resurrecting a killed (exit 137) record back to `executing`. The `alive && executed` branch in `enrich_detached_status` now consults the recorded exit code and the `Exit Code:` log footer before flipping, so a lingering shell that outlives a `SIGKILL`ed command no longer reports a completed command as still running.

Fixed detached docker `--status`/`--list` reporting a terminal status (`executed`) with the `-1` sentinel while the container is still running (or not visible yet on a slow Docker-in-Docker host). `is_detached_session_alive` now treats a failed `docker inspect` as "unknown" (`None`) instead of "stopped", so a session whose container has not appeared yet stays `executing` rather than being marked finished. When a container has genuinely stopped, `enrich_detached_status` resolves the real exit code from the `Exit Code:` log footer and then `docker inspect .State.ExitCode`, only falling back to `-1` when no real code can be obtained.

## [0.16.0] - 2026-06-09

Add Docker isolation runtime controls: `--volume`/`-v`, `--mount`, `--env`/`-e`, and `--privileged`. These are threaded into the underlying `docker run` invocation and recorded in `--status`/`--list` metadata, allowing callers to mount tool credentials, pass environment variables, and run Docker-in-Docker images without wrapping `docker run` themselves.

## [0.15.1] - 2026-06-07

Add `--isolation` as an alias for `--isolated` and fail fast on unknown wrapper options.

## [0.15.0] - 2026-05-21

Add `--upload-log <id>` to upload a stored execution log with `gh-upload-log`, installing the uploader on demand when it is missing.

## [0.14.3] - 2026-05-12

Fix Links Notation indentation for nested process ID arrays in status and control output, and update direct Rust dependencies.

## [0.14.2] - 2026-05-03

Publish Rust crates to crates.io before creating the Rust GitHub Release.


## [0.14.1] - 2026-05-02

fix: correct license field from MIT to Unlicense (public domain)

Updated `Cargo.toml` to correctly reflect the Unlicense (public domain) license instead of MIT. The project's `LICENSE` file has always contained the Unlicense text; this change aligns the metadata with the actual license.

Fixes #99

fix: support --session name lookups in --status and track detached session lifecycle

`--status` now accepts session names in addition to UUIDs. When using `--isolated screen --detached --session my-session`, you can query status with `--status my-session` instead of needing to extract the internal UUID.

Detached mode no longer incorrectly reports immediate completion. The status is determined at query time by checking if the actual screen/tmux/docker session is still running.

Also fixed missing execution tracking in Rust's `run_with_isolation()` — isolation executions are now properly tracked and queryable.

Fixes #101

fix: Record detached isolation output in the tracked log path in real time.

feat: Add currentTime to --status output for executing commands

When `--status <uuid-or-session>` is called for a command whose status is `executing`, the output now includes a `currentTime` field right after `startTime` in all three output formats (links-notation, JSON, text). This makes it trivial to compute how long a command has been running by comparing `startTime` and `currentTime`. Completed executions are unchanged; `endTime` already reflects completion.

Fixes #105

fix: unblock Rust releases and add language prefixes for GitHub releases

Three independent bugs prevented Rust releases from ever being published:

- `.github/workflows/rust.yml` `auto-release` job was silently skipped on
  every push to `main` because its `if:` condition lacked the
  `always() && !cancelled()` guard that upstream jobs with `always()`
  require. Adopted the guard from the upstream
  `rust-ai-driven-development-pipeline-template`.
- `scripts/create-github-release.mjs` dropped the `--prefix` argument on
  the floor, so every Rust release would have been created with tag
  `v<version>` and collided with the JavaScript release of the same
  number. The script now reads `--prefix`, uses `${prefix}v${version}`
  as the tag (`rust-v0.14.0`) and `[Rust] ${version}` as the release
  title.
- `scripts/format-github-release.mjs` had the same missing `--prefix`,
  so the formatter could not find the release it just created.

Also adds `rust/README.md` with crates.io / docs.rs / CI / license badges,
a complementary `js/README.md` with npm / CI / license badges, and a
`docs/case-studies/issue-108/` case-study folder with the full
investigation.

Fixes #108

feat: Add --list for tracked command executions

Added `start --list` to show every execution record stored for `--status` lookups. The default output is Links Notation, with JSON and text available through `--output-format`.

Fixes #110

feat: Add `--stop` and `--terminate` controls for detached isolated executions and include best-effort process IDs in status output.

Fix Rust release automation so changelog-based and manual releases use Cargo versioning, language-prefixed GitHub Releases, and exact-version badges.

feat: Improve command output formatting with human-readable timestamps and duration

- Changed timestamp format from `[timestamp] Starting:` to `Starting at timestamp:`
- Changed finish message from `[timestamp] Finished` to `Finished at timestamp in X.XXX seconds`
- Added performance metric showing command execution duration
- Added `format_duration` helper function for consistent duration formatting

fix: Use piped stdout/stderr with threads for reliable real-time output capture

- Changed from `Stdio::inherit()` with `.output()` to `Stdio::piped()` with `.spawn()`
- Added threads to read stdout/stderr in real-time while also capturing for the log file
- Ensures both immediate output display and proper log file capture on macOS
- Fixes Issue #57: Commands like `echo hi` now show output and finish block reliably

feat: Add signal handling and cleanup for stale execution records

- Added signal handlers for SIGINT, SIGTERM, and SIGHUP to properly update
  execution status when a command is interrupted
- Added --cleanup and --cleanup-dry-run CLI options to clean up stale
  "executing" records (processes that crashed or were killed)
- Stale detection based on: process no longer running, or age > 24 hours
- Exit codes follow convention: 128 + signal number (e.g., 130 for SIGINT)
- Cleaned records marked as "executed" with exit code -1

Fixes #60

feat: Use OS-matched default Docker image when --image is not specified

- Docker isolation no longer requires --image option; a default is used
- Default image is selected based on host OS:
  - macOS/Windows: alpine:latest (lightweight, portable)
  - Ubuntu: ubuntu:latest
  - Debian: debian:latest
  - Arch Linux: archlinux:latest
  - Fedora: fedora:latest
  - CentOS/RHEL: centos:latest
  - Other Linux: alpine:latest (fallback)

Fixes #62

feat: Replace fixed-width box output with status spine format

- Replaced box-style output format with spine format using `|`, `$`, `✓`, and `✗` symbols
- Removed all legacy BoxStyle, get_box_style(), and box-drawing functions
- Added new spine format functions: create_spine_line, create_empty_spine_line, create_command_line
- Added get_result_marker function returning success/failure symbols
- Added IsolationMetadata struct and parsing for isolation environment info
- Updated create_start_block and create_finish_block to use spine format
- Format is width-independent, lossless, and portable across all terminal environments

fix: Always display session/container name in isolation output

When using isolation backends (screen, docker, tmux), the output now always displays
the actual session/container name that users need to reconnect to sessions. Previously,
the session name was only shown if explicitly provided via `--session` flag.

This allows users to:
- Reconnect to detached screen sessions: `screen -r <name>`
- Attach to tmux sessions: `tmux attach -t <name>`
- View Docker container logs: `docker logs <name>`
- Remove containers: `docker rm -f <name>`

Fixes #67

feat: Rename spine to timeline, add virtual command visualization for Docker

- Renamed "spine" terminology to "timeline" throughout the codebase
  - `SPINE` constant → `TIMELINE_MARKER` (old name deprecated)
  - `create_spine_line()` → `create_timeline_line()` (old name deprecated)
  - `create_empty_spine_line()` → `create_empty_timeline_line()` (old name deprecated)
- Added virtual command visualization for Docker image pulls
  - When Docker isolation requires pulling an image, it's shown as `$ docker pull <image>`
  - Pull output is streamed in real-time with result markers (✓/✗)
  - Only displayed when image actually needs to be pulled (conditional display)
- New API additions:
  - `create_virtual_command_block()` - for formatting virtual commands
  - `create_virtual_command_result()` - for result markers
  - `docker_image_exists()` - check if image is available locally
  - `docker_pull_image()` - pull with streaming output
  - `StartBlockOptions.defer_command` - defer command display for multi-step execution
- All deprecated items have backward-compatible aliases for smooth migration

Fixes #70

fix: Complete visual continuity fix for docker isolation mode

- Fixed empty line placement in docker isolation output
- Empty line is now correctly placed AFTER the command (`$ docker pull alpine:latest`)
- Added empty line BEFORE the result marker (`✓` or `✗`) for visual separation
- Ensures consistent visual formatting around all commands

Expected format:
```
│
$ docker pull alpine:latest

latest: Pulling from library/alpine
...

✓
│
$ echo hi

hi

✓
```

Fixes #73

feat: Add shell auto-detection and --shell option for isolation environments

In docker and ssh isolation environments, the shell is now automatically
selected in order of preference: bash, zsh, sh (auto mode). A new `--shell`
option allows explicitly specifying the shell to use.

- Auto mode (default): probes the docker image or SSH host for the best available shell
- `--shell bash/zsh/sh`: forces a specific shell
- `--shell auto`: explicitly selects auto-detection mode
- For SSH in auto mode, command is passed directly to preserve the remote user's login shell

This enables tools like `nvm` to work correctly in Docker containers where
bash is available but sh does not source the necessary profile scripts.

Fixes #79

feat: Use interactive shell mode in isolation environments to source startup files

In docker and ssh isolation environments, bash and zsh are now invoked with
the `-i` (interactive) flag when executing commands. This ensures that startup
files like `.bashrc` and `.zshrc` are sourced, making environment-dependent
tools like `nvm`, `rbenv`, `pyenv`, and similar version managers available
in isolated commands.

Previously, even though bash was correctly detected and used over sh, running
`nvm --version` in a Docker container would fail with "command not found"
because bash was started in non-interactive mode and did not source `.bashrc`.

With this fix:
- Docker: `docker run <image> bash -i -c "nvm --version"` sources `.bashrc`
- SSH: `ssh <host> bash -i -c "nvm --version"` sources `.bashrc` on the remote host
- `zsh` also gets the `-i` flag for the same reason
- `sh` does not get `-i` as it is used as a fallback for minimal containers

Fixes #79

feat: Sync Rust version with JavaScript version - add missing tests and CI parity checks

Added comprehensive tests and CI/CD enforcement to keep Rust and JavaScript implementations in sync:

**New Rust tests (161 → 455+ test cases):**
- `sequence_parser` module: new module mirroring JS `sequence-parser.js` for isolation stacking
- `regression_84`: shell-inside-shell prevention tests (issue #84)
- `regression_91`: shell-with-c-flag double-wrapping prevention tests (issue #91)
- `args_parser_shell`: shell option parsing tests (--shell flag)
- `args_parser`: comprehensive args parser tests covering all options
- `isolation_unit`: unit tests for isolation utilities (wrap_command_with_user, detect_shell, etc.)
- `output_blocks_extended`: extended output blocks formatting tests
- `execution_store`: execution store CRUD and statistics tests
- `sequence_parser`: sequence parsing, formatting, distribution tests

**New public API functions in isolation module:**
- `is_interactive_shell_command()`: detects bare interactive shell commands (e.g., "bash", "zsh")
- `is_shell_invocation_with_args()`: detects shell invocations with -c flag (e.g., "bash -c cmd")
- `build_shell_with_args_cmd_args()`: builds argv for shell-with-c commands without double-wrapping

**New sequence_parser module:**
- `parse_sequence()`: parse space-separated sequences with underscore placeholders
- `format_sequence()`: format sequence back to string
- `shift_sequence()`: remove first element from sequence
- `is_sequence()`: check if value is multi-level sequence
- `distribute_option()`: distribute option across isolation levels
- `get_value_at_level()`: get value at specific isolation level
- `format_isolation_chain()`: human-readable isolation chain description

**New CI/CD checks:**
- Test count parity: fails if Rust has ≥10% fewer tests than JavaScript
- Code coverage: fails if test coverage drops below 80% (using cargo-tarpaulin)
- New `scripts/check-test-parity.mjs` script for parity enforcement

**Documentation updates:**
- `ARCHITECTURE.md`: added dual-language implementation section with sync requirements
- `REQUIREMENTS.md`: added section on dual-language sync requirements and coverage thresholds

Fixes #93

fix: capture output from quick-completing commands in screen isolation (issue #96)

When running a short-lived command like `agent --version` through screen isolation,
the output was silently lost because GNU Screen's internal log buffer flushes every
10 seconds by default. For commands that complete faster than this, the buffer may
not be flushed to the log file before the screen session terminates.

**Fix:** A temporary screenrc file with `logfile flush 0` is passed to screen via
the `-c` option. This forces screen to flush the log buffer after every write,
eliminating the 10-second flush delay for quick-completing commands.

A retry mechanism is also added for the tee fallback path (older screen < 4.5.1)
to handle the TOCTOU race where the log file appears empty when first read
immediately after session completion.

The screen-related functions have also been extracted from `isolation.rs` into a
new `isolation_screen.rs` module to keep file sizes under the 1000-line limit.

Fixes #96

fix: use screenrc-based logging for all screen versions (issue #96)

Replace the version-dependent logging approach (native -Logfile for screen >= 4.5.1,
tee fallback for older versions) with a unified screenrc-based approach that works on
ALL screen versions including macOS bundled 4.00.03.

The screenrc uses `logfile`, `logfile flush 0`, and `deflog on` directives available
since early screen versions, eliminating both the tee fallback and version detection
for logging strategy.

Additional improvements:
- Exit code capture via sidecar file ($? saved after command completes)
- Enhanced retry logic with 3 retries and increasing delays (50/100/200ms)
- Better debug output responding to both START_DEBUG and START_VERBOSE
- New tests for exit code capture and stderr output capture

Fixes #96

