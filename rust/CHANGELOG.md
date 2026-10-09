# Changelog

All notable changes to the Rust package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- changelog-insert-here -->
## [0.23.0] - 2026-10-09

Add Docker launch/recovery limits with daemon percentages and random ranges, opt-in delayed CPU penalties, remote/DinD memory diagnostics, durable launch reservations and atomic store writes. Require exit-time OOM evidence and recognize attributed Docker daemon restarts in attached/detached status.

## [0.22.4] - 2026-10-06

Scope explicit resume status, memory evidence and log reads to execution attempts; preserve earlier evidence in attempt history and report launch, watcher, output and terminal lifecycle separately, matching JavaScript.

## [0.22.3] - 2026-10-05

Report OOM kill scope as unknown when only cgroup memory counters are available. Allocation events and killed processes have different units, so their comparison cannot establish container, parent or host scope. Preserve raw counters and the exit-code guard for earlier child OOM kills.

## [0.22.2] - 2026-10-05

Stop reporting `exitReason: memory-exhaustion (cgroup-oom-killer)` and `memoryExhausted: true` (`Docker reported State.OOMKilled=true`) for executions that exited 0, 1 or any other ordinary code while Docker's sticky `OOMKilled` flag was set. The flag is container-wide (moby/moby#43564): it turns on when *any* process in the container is OOM-killed, such as a `rustc` child under `cargo test`, and stays on until the next start. It now counts as the exit reason only when the command itself died by SIGKILL (exit 137) or its exit code is unknown, the same rule `--on-kill-resume` uses since #178. `oomKilled: true` is still reported. A stale cgroup reason stored by an older version is dropped by `--status`. An attached container kept after a child OOM kill now says `Docker reports a process in it was OOM-killed`.

Add `--on-kill-resume-delay <min[-max]>` for `--on-kill-resume`/`--recovery-command`: wait a uniformly random number of seconds (e.g. `30-90`; one number is a fixed delay, the default `0` resumes at once) before each recovery, so executions killed by the same host-wide OOM event do not all restart in the same second and trigger the next one. The chosen delay is printed in the `[Recovery k/N]` line, stored as `delayMs` in `recoveryHistory` and as `lastRecoveryDelayMs`, and shown in the `[Isolation] On kill:` line. A `--stop` or `--terminate` during the wait cancels the pending resume; `--terminate` of the already exited container now reports `recovery-cancelled` instead of failing.

Record the container's cgroup v2 memory counters for detached Docker executions: the completion watcher samples `memory.max`, `memory.peak` and the `memory.events` `oom`/`oom_kill` counters every second (and once more after the container exits, since the cgroup disappears with it). They are written as a `Memory:` line after the container post-mortem, stored as `cgroupMemory` (`limitBytes`, `peakBytes`, `oomEvents`, `oomKills`) and shown by `--status` as `Cgroup Memory:` with a note telling a container-limit OOM (`oom_kill == oom`) from a host-wide or parent-cgroup OOM (`oom_kill > oom`). A non-zero `oomKills` explains a SIGKILL or unknown exit as a cgroup OOM kill, and each `--on-kill-resume` `recoveryHistory` entry notes `oomEvents`/`oomKills` of the killed run. Hosts without cgroup v2 or with a remote `DOCKER_HOST` record nothing.

## [0.22.1] - 2026-10-03

Do not resume `--on-kill-resume` executions whose main process exited 0–127 on its own while Docker's sticky `OOMKilled` flag was set. Docker sets `OOMKilled` when *any* process in the container was OOM-killed (a compiler, a test runner, a child `node`) and keeps it until the next start, so a run that survived that and later exited 0 or 1 was resumed as if it had been killed. A run now counts as killed only on exit 137, or on `OOMKilled` without a usable exit code; `oomKilled: true` is still reported in `--status` and the post-mortem.

## [0.22.0] - 2026-10-02

Keep Docker resource limits across `--resume <id> -- <command>`, and add `--on-kill-resume <N>` / `--recovery-command <cmd>`. `docker commit` does not capture HostConfig, so the snapshot resume now reads the stopped container's limits with `docker inspect` (including ones applied later with `docker update`) and re-applies the non-default ones (`--memory`, `--memory-swap`, `--memory-reservation`, `--cpus`/`--cpu-quota`/`--cpu-period`, `--cpu-shares`, `--cpuset-cpus`, `--cpuset-mems`, `--pids-limit`, `--shm-size`, `--storage-opt`, `--ulimit`) to the `-resume-N` container, prints them as `[Isolation] Resource limits: ...` and stores them as `resourceLimits`. With `--on-kill-resume <N>` a detached Docker execution whose main process is killed (exit 137 or `OOMKilled`) is resumed in the same container up to N times, running `--recovery-command` (or the original command) with `START_COMMAND_RECOVERY_ATTEMPT` set. The UUID and log file are kept, each attempt is separated by a `[Recovery k/N]` line, and `--status` shows `recoveryAttempts` and `recoveryHistory`. `--stop` cancels further recovery.

## [0.21.1] - 2026-09-28

Never finalize a still-running detached Docker container as a success. `docker logs -f` also returns when its own write to the log fails (ENOSPC) or when dockerd restarts, so the completion watcher now asks `docker inspect -f '{{.State.Running}}'` and keeps waiting with `docker wait` until the container really exits. If the watcher still sees a running container, it notes this in the log and leaves the container and the execution record alone: no `docker rm -f`, no `Exit Code: 0` footer, and no `executed` status (the finalizer refuses with `still-running`). A zero `FinishedAt` (`0001-01-01T00:00:00Z`) combined with an exit code of 0 is recorded as `-1` with `exit_reason: watcher-lost-container`, not as a success.

## [0.21.0] - 2026-09-16

Persist the terminal state of a detached Docker execution and record the container post-mortem. The completion watcher now writes `status`, `exitCode`, `oomKilled` and a real `endTime` back into the store instead of leaving the record `executing` forever, so `--status` stops calling the clock at query time and reporting a different "finish" on every call. `endTime` carries its provenance in `endTimeSource` (`docker-finished-at`, `log-footer`, `observed-at`); a stale record keeps `endTime` empty and records `staleDetectedAt` instead of a fabricated finish time. The single `docker inspect` now also collects `StartedAt`, `FinishedAt` and `State.Error`, and both the detached and the attached path write a post-mortem block for a kept container and a one-line note for a removed one. Signal decoding (`128+n`) is shared by the log and `--status`, so `137` reads as `137 (SIGKILL - 128+9)` everywhere.

## [0.20.0] - 2026-09-03

Add `--attach`, `--resume`, `--resume-all` and `--list --running` so a detached isolated session can be re-entered, continued, or repaired after a supervisor restart, and surface an `exitReason` hint when a log shows memory exhaustion.

Keep argument boundaries when rebuilding the command from `argv`: `start node -e "console.log('hi')"` and `start echo "a  b"` now reach the shell with their quoting intact instead of being re-split by the inner `bash -c`. A single argument still runs verbatim as a shell script, so `start 'ls | wc -l'` keeps working; in the multi-argument form a quoted operator such as `start echo a '&&' echo b` is now a literal word.

Surface `memoryExhausted` and `memoryExhaustedReason` in `--status` when the log shows the runtime aborted on its own memory limit: a Node/V8 heap-limit abort dies below the container limit, so `oomKilled` stays `false` and the only evidence is the `FATAL ERROR` line the runtime printed. The log tail is now scanned with a 64 KiB window (V8 prints a long native stack trace after the marker), the observation covers attached sessions too, and the kept-container footer no longer asserts a bare `oomKilled=false` next to a fatal marker for exit codes 134/139.

### Added

- `tests/ci_workflow_invariants.rs`: six new invariants mirroring the JavaScript
  suite - the workflows are linted and audited by a workflow of their own,
  untrusted context is never interpolated into a `run:` block, read-only
  checkouts do not persist credentials, third-party actions are pinned to a
  commit hash, both dependency graphs are audited for advisories, and the
  repository-level `scripts/` directory is linted.

### Fixed

- `user_manager`: isolation usernames are drawn from the operating system's
  CSPRNG (`Uuid::new_v4`, with rejection sampling for a uniform base36 suffix)
  instead of a time-seeded xorshift generator, which produced identical
  suffixes for processes started in the same millisecond.
- `failure_handler::create_issue` no longer escapes quotes and newlines before
  handing the title and body to `gh`. No shell is involved, so the escaping
  only put backslashes into the reported issue and flattened its newlines into
  the two characters `\n`.
- `failure_handler` no longer gates the npm `bugs.url` fallback on a
  `contains("github.com")` substring test; `parse_git_url` anchors on the host
  itself.
- `scripts/check-file-size.mjs` now normalises paths to forward slashes before
  matching its exclusion list and reporting violations, so the exclusions apply
  on Windows as well as on Linux.
- Tests no longer interpolate generated usernames, session names or UUIDs into
  their assertion messages. CodeQL's `rust/cleartext-logging` treats such a
  value reaching a panic (which the harness writes to its log) as a leak, and
  each assertion is about the shape rather than the value.

## [0.19.2] - 2026-08-10

Keep Docker multi-network regression coverage hermetic while verifying the default bridge route.

## [0.19.1] - 2026-08-10

Make the Docker multi-network integration test hermetic and add opt-in
`START_DEBUG` tracing to the Docker network lifecycle helpers.

## [0.19.0] - 2026-08-10

Allow Docker isolation to join multiple networks before starting the command.

## [0.18.0] - 2026-08-09

Add `--network` and repeatable `--network-alias` options for Docker-isolated commands.

## [0.17.5] - 2026-08-04

Stop `--status` from fabricating a detached session exit code out of the command's own output: the terminal exit code is now read from the anchored three-line footer `start` writes (separator / `Finished:` / `Exit Code:`) in the tail of the log only, and Docker's own `.State.ExitCode` takes precedence over the log text.

## [0.17.4] - 2026-08-04

Treat Docker OOMKilled as an observation rather than a verdict in `--status` / `--list`: a detached session whose container is still running stays `executing` (with `oomKilled true` alongside), a stopped container reports its real `.State.ExitCode`, and `137` is used only when the container is gone and neither a log footer nor an exit code can be recovered.

## [0.17.3] - 2026-07-05

Treat detached Docker sessions with OOMKilled as terminal in status output, using Docker's exit code when available and 137 as the OOM fallback.

## [0.17.2] - 2026-06-26

Surface detached Docker OOMKilled status and preserve abnormal containers under the default cleanup policy.

## [0.17.1] - 2026-06-24

Use `docker stop` for detached Docker `--stop` control so Docker isolation containers stop reliably while `--terminate` remains immediate.

## [0.17.0] - 2026-06-24

Clean up Docker isolation containers by default after completion, preserve host log files, and add explicit `--keep-container`, `--always-cleanup-container`, and `--keep-container-on-fail` cleanup policy flags.

## [0.16.2] - 2026-06-19

Record the docker image-preparation phase in the session log (issue #138). When a `--isolated docker` run needs to `docker pull` an image, each line of pull output is now teed into the session-log file in real time and bracketed with `Preparing image <name>…` / `Image ready (<duration>)` markers (or `Image preparation failed` on error). Previously the time spent pulling a (potentially multi-GB) image left no trace in the log, so operators tailing the session log during startup saw only the header. The single session-log file is now a gap-free record of the run, including the longest, most failure-prone phase.

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

