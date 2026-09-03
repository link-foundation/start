# Solutions and verification

## Selected solution

### Probe first, act second

`--attach`, `--resume` and `--resume-all` all need the same question answered
before they can do anything: is the session behind this record alive, stopped
but recoverable, or gone? A single read-only `session-probe` /
`session_probe` module answers it as `running`, `stopped`, `missing` or
`unknown`, so all three verbs share one notion of liveness and the probe is safe
to run across every tracked record.

### `--attach` hands over the terminal

For a live session the plan is `docker attach`, `screen -r` or `tmux attach`
depending on the backend. `--read-only` switches to the following variants —
`docker logs -f`, `screen -x`, `tmux attach -r` — so output can be followed
without stdin. If the session is stopped or gone, attaching is refused with an
error that names `--resume` instead of failing generically.

### `--resume` picks one of three strategies

| Probe state       | Replacement command | Strategy          | What runs                                                            |
| ----------------- | ------------------- | ----------------- | -------------------------------------------------------------------- |
| stopped container | none                | `docker-start`    | `docker start <name>` re-runs the stored entrypoint in place.        |
| stopped container | given after `--`    | `docker-snapshot` | `docker commit` the filesystem, then run the new command against it. |
| session missing   | either              | `relaunch`        | The command is launched again through the stored isolation options.  |

`docker-snapshot` is what makes `--resume <id> -- <command>` possible at all. A
stopped container's entrypoint is fixed, so the only way to run a _different_
command against the same filesystem is to capture that filesystem as an image
and derive a new container from it. The snapshot carries the original runtime
configuration forward — `--privileged`, volumes, environment, networks — so the
resumed command sees the same environment, not just the same files.

Session identity is preserved deliberately: the execution UUID never changes,
the new container name is derived (`<name>-resume-<n>`), and the previous name
is appended to `sessionNameHistory` so it still resolves. `--status`,
`--list` and `--upload-log` therefore keep addressing one logical session across
any number of restarts.

### `--resume-all` repairs observation, never restarts work

Each record still marked running is probed and classified:

| Action       | Condition                           | Effect                                                   |
| ------------ | ----------------------------------- | -------------------------------------------------------- |
| `reattached` | live docker container               | A fresh completion watcher is started.                   |
| `running`    | live screen/tmux session            | Nothing; its logging is in-session. Reported only.       |
| `reconciled` | session gone                        | Record finalized from the same evidence `--status` uses. |
| `unknown`    | backend not locally probeable (ssh) | Left untouched, with an explicit reason.                 |

No branch launches a command. Continuing actual work stays an explicit
per-session `--resume` decision, for the reason set out in `root-cause.md`.

### `exitReason` explains without overriding

The log tail already read for the exit-code footer is scanned for fatal markers,
most specific first. The reported incident's marker yields
`memory-exhaustion (v8-heap-limit)`; kernel OOM-killer messages and allocation
failures have their own values. The field is additive and never changes
`status`, `exitCode` or `oomKilled`.

## Alternatives considered

### Document `docker commit` and let callers do it

Rejected. It reproduces the current failure mode one level up: the caller must
know the container name, the retention policy, the original runtime flags, and
must reconstruct them by hand. It also cannot preserve the execution UUID, so
`--status` would fragment into unrelated records — explicitly against R5.

### Make `--resume` always relaunch through the isolation backend

Simple and uniform, but it throws away the container filesystem, which is the
asset the issue is about. Relaunch is kept only as the fallback for a session
that no longer exists.

### Have `--resume-all` restart every stuck command

Rejected as unsafe. A record marked `executing` may describe a container that is
still working (restarting duplicates it) or one that already finished unobserved
(restarting discards its results). Neither can be distinguished from the record
alone, so the safe repair is to restore observation and let a human or
supervisor decide per session.

### Overwrite `oomKilled` to `true` on a heap-limit abort

Rejected. `oomKilled` mirrors Docker's `State.OOMKilled` and is correct as
recorded; #148 and #151 established it as an observation, never a verdict.
Falsifying it would trade one misleading field for another and break consumers
that read it as the kernel-level signal it is.

### Reuse `--status` output for `--resume-all`

Rejected as insufficient. `--status` reports state; the repair also has to start
watchers and write finalized records. `--list --running` covers the read-only
half of the need and is exposed separately for exactly that reason.

## Automated verification

| Check                                               | Result                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| JavaScript end-to-end regression (`regression-162`) | 13 pass (`data/js-focused-test.log`).                                   |
| Rust end-to-end regression (`regression_162`)       | 14 pass (`data/rust-focused-test.log`).                                 |
| JavaScript full suite                               | 837 pass / 0 fail across 47 files (`data/local-js-full.log`).           |
| Rust full suite                                     | 28 green test binaries, 244 library cases (`data/local-rust-full.log`). |
| JavaScript lint, format, file size                  | Pass (`data/local-js-lint.log`, `-format.log`, `-filesize.log`).        |
| Rust `cargo fmt`, Clippy, file size                 | Pass, zero warnings (`data/local-rust-*.log`).                          |
| Documented example checks, both implementations     | 4 examples each (`data/local-doc-js.log`, `-rust.log`).                 |
| Test-count parity                                   | 826 Rust vs 780 JavaScript, 105.9% (`data/local-test-parity.log`).      |
| Changeset validation                                | Minor bump validated (`data/local-changeset-validation.log`).           |

Both regression suites are hermetic: they spawn the real CLI against a temporary
`START_APP_FOLDER` and never require Docker, screen, tmux or a network. The
unit-level Rust tests inject `CommandRunner`, `InteractiveRunner` and
`ResumeHooks` fakes so that plan building, snapshotting and reconciliation are
verified without a daemon.

## Operational follow-up

`exitReason` currently recognises V8 heap limits, kernel OOM-killer messages and
allocation failures. The marker table is data, not logic, so further fatal
signatures (Go `fatal error: out of memory`, JVM `OutOfMemoryError`) can be
added without touching the detection path. Any addition should keep the same
rule: a hint that explains an exit code, never one that rewrites it.
