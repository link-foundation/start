# Daemon-restart evidence without the host journal

[Issue #241](https://github.com/link-foundation/start/issues/241) reports that
the daemon-restart attribution from #194 (`Exit evidence:
docker-daemon-restart`, `exitReason: killed (docker daemon restart)`) depended
on `journalctl -u docker.service`. A `$` running inside a container that reaches
the host daemon through a mounted `/var/run/docker.sock`
(Docker-outside-of-Docker, DooD) has an unset `DOCKER_HOST`, so the check counted
as "local". But that container has no host journal, so a task force-killed by a
daemon restart ended with `Exit evidence: unavailable`. The full issue is in
`issue.json`.

## What survives a daemon restart

- `docker events` keeps its history in the daemon's memory, so a restart loses it.
  It cannot show the restart that just happened (the issue says the same).
- `State.FinishedAt`, `State.StartedAt`, `State.ExitCode` and `State.OOMKilled`
  are stored in each container's `config.v2.json` and survive the restart.
- dockerd stops containers on shutdown with their stop signal and kills the rest
  when its shutdown timeout ends (15 s by default, `shutdown-timeout`). The
  containers of one restart therefore finish within about 15 s of each other,
  with exit 143 (SIGTERM) or 137 (SIGKILL).
- A container that its restart policy started again has a new `StartedAt` later
  than its `FinishedAt`. moby resets `ExitCode` to 0 in `SetRunning`, but keeps
  `FinishedAt`.

## Implementation (JavaScript first, Rust parity)

`collectExitEvidence` / `exit_evidence::collect` keep their order: host journal,
then the task's Docker `oom` event, then a new Docker API check
(`daemonRestartApiEvidence` / `daemon_restart_api_evidence`):

1. `docker ps -a -q --no-trunc` lists the other containers (at most 256 are
   inspected).
2. One `docker inspect -f '{{.Id}} {{.State.FinishedAt}} {{.State.StartedAt}}
{{.State.ExitCode}} {{.State.OOMKilled}}'` call reads their state. A
   container removed between the two calls makes inspect exit 1, but the others
   are still printed, so the output is used either way.
3. A peer supports the restart when it is not the task itself, was not
   OOM-killed, finished within 15 s of the task's `FinishedAt`, and either
   exited 137/143 or was started again after it finished.

On a match the line is `Exit evidence: docker-daemon-restart (Docker API:
containers finished together)`. It resolves to the same `killed (docker daemon
restart)` reason as the journal line. Attempt-scoped OOM evidence (a fresh cgroup
`oom_kill` delta) still wins, and in that case the peer check does not run. The
check also runs for remote daemons (`DOCKER_HOST=tcp://…`), where the journal was
never consulted.

### Which source supported the attribution

The stored `exitEvidence` object now gets `daemonRestartSource: "journal"` or
`"api"` whenever `daemonRestart` is true. Nothing changes for other evidence,
so existing JSON output is unchanged. This applies to every writer of
`exitEvidence`: detached finalization, killed-execution recovery and attached
diagnostics, in both languages.

### The watcher dies with the daemon

In DooD the detached completion watcher runs `docker wait` against the same
daemon, so the restart that kills the task usually kills the watcher's `docker`
client too, before it can log any evidence. `--status` therefore collects the
evidence itself when it reconciles such a record (`collectLostWatcherEvidence` /
`collect_lost_watcher_evidence`). That happens only when the record has no stored
`exitEvidence`, the log has no `Exit evidence:` line, and the container is stopped
with exit 137. The result is cached per process (by session name and
`FinishedAt`), so `--list` does not repeat the queries.

## Limitations

- Stopping or killing several unrelated containers by hand within the same 15 s
  window looks like a restart to the API check. The journal, when available,
  is still consulted first.
- Only exit 137 is attributed, as in #194. A task that handled SIGTERM and exited
  143 during a restart keeps its plain signal reason.
- A daemon restart that killed only the task (no other container on the host)
  leaves no peer evidence, and the result stays `unavailable`.

## Requirement evidence

| Requirement                                                            | Implementation                                                   | Verification                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Same attribution without host journal access, through the socket only  | Docker API peer check in `exit-evidence.js` / `exit_evidence.rs` | `regression-241.js` / `regression_241.rs`: socket-only runner, no journal         |
| Peers with close `FinishedAt`, exit 137/143, no OOM                    | `daemonRestartApiEvidence` / `daemon_restart_api_evidence`       | Positive case plus OOM, 30 s apart, clean exit, never ran and malformed negatives |
| Peers restarted after the `FinishedAt` (`StartedAt` later)             | Same function; exit-code reset handled                           | "restarted ... ExitCode reset" test in both languages                             |
| `docker events` not used for this                                      | State-based check only                                           | Code review; the event query is still only for `oom`                              |
| Report which source supported the attribution                          | Marker text and `exitEvidence.daemonRestartSource`               | Source tests in both languages; `--status` JSON test                              |
| Test with stubbed `docker inspect` / `docker ps -a` for two containers | Both regression suites                                           | 12 JS tests, 7 Rust tests (the Rust peer negatives share one test)                |
| The DooD watcher may not survive to log evidence                       | `--status`-time collection for stopped 137 containers            | End-to-end `queryStatus` / `query_status` test with fake `docker`/`journalctl`    |

`ci-logs/issue-241/reproduction-before.log.gz` shows the JavaScript suite on the
original code: 11 of 12 fail. The negatives fail because the API check did not
exist; the one that passes is the check that sampled OOM evidence keeps
priority. `reproduction-after.log.gz` shows all 12 passing.
