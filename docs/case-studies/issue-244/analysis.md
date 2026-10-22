# Opt-in `--init` so orphaned processes are reaped

[Issue #244](https://github.com/link-foundation/start/issues/244) counted 429
zombie processes on a link-assistant/hive-mind task host. One task had 94
`chrome`, 34 `chrome_crashpad`, 24 `cat` and 16 `sleep` zombies after 25
minutes, and another had 185 `sh` zombies after 2 hours. All of them had the
container's PID 1 (`node`) as their parent, and `HostConfig.Init` was unset for
every task container. The full issue is in `issue.json`.

## Root cause

`$ --isolated docker` runs `docker run … <image> <shell> -c <command>`, so the
user's command (or the shell that `exec`s it) is PID 1 of the container's PID
namespace. When a process exits, the kernel re-parents its children to the
namespace's PID 1. That process has to `wait()` for them, or each one stays a
zombie until the container exits. `node`, `python` and most programs never do
this, because outside a container that job belongs to the host's init.

Each zombie keeps its PID and kernel task struct. They count against
`--pids-limit` and the host's `pid_max`, and they slow down every `/proc` scan.
They use no CPU, so this is a slow resource leak, not a hang.

## Existing components

| Option | Notes |
| --- | --- |
| `docker run --init` | Docker ships tini as `docker-init` (`docker info`: `InitBinary=docker-init`, commit `de40ad0` = tini v0.19.0 on Docker 29.9.1). `/proc/1/exe` becomes `/sbin/docker-init` and the command runs as its child. tini reaps every orphan, forwards signals to its child, and exits with the child's code (`128 + n` when the child dies from signal `n`). No image change is needed, so it works for any `--image`. **Chosen.** |
| daemon.json `"init": true` | The same tini, for every container on the daemon. It cannot be scoped to `$` launches, and it changes containers `$` did not start. Hosts that want it anyway can set it. `$` neither needs nor overrides it. |
| tini or dumb-init in the image | Needs every image to change. `$` runs arbitrary user images. |
| A reaper inside the `$` shell wrapper | `$` would have to stay PID 1 and forward signals itself. That duplicates tini and changes the PID-1 signal semantics users rely on. |

## What changed (JavaScript first, Rust in parity)

| Requirement from the issue | Implementation |
| --- | --- |
| A launch option `--init` for `--isolated docker` that adds `docker run --init` | `docker-init-option.js` / `docker_init_option.rs` parse `--init` and `--no-init`. `buildDockerRuntimeArgs` / `build_docker_runtime_args` add `--init` right after `--privileged`, before `-e`/`-v`/`--network`. `--init` without docker in the isolation stack is rejected. In JS, a stack such as `-i screen docker --init` passes the flag to the docker level (`command-builder.js`). |
| Stored in the execution record | `buildDockerRuntimeMetadata` / `build_isolation_options_map` store `init: true` (nothing when off, so records stay as they were). |
| Reused by `--resume` / `--resume-all` | `buildLaunchOptions` / `build_launch_options` read `init` back from the record. A relaunched or snapshot-resumed container gets `--init` again, and a record from before #244 gets none. `--resume-all` never creates a container. It re-attaches a watcher or reconciles the record, and the container keeps its own `HostConfig.Init` across `docker start` (checked: still `true`, PID 1 still `docker-init`). |
| Shown in the `[Isolation]` lines and `$ --status` | `[Isolation] Init: true` after the privileged line, an `init true` row in the start block before `user`, and `"init": true` in the `$ --status` options. |
| Optional environment default | `START_COMMAND_DOCKER_INIT` set to `1`, `true`, `yes` or `on` (case-insensitive) turns it on for docker launches. `--no-init` overrides it. Without docker it is ignored, never an error. |
| The default stays off | Without a flag or the variable, `docker run` gets no `--init`, as before. |
| Exit evidence should stay the same, with a regression test | Real-daemon tests and the experiment below. |

Details:

- **Validation is idempotent.** The JS `validateOptions` can run more than once
  on the same options (for example in the attach/resume paths). After the first
  run, `init` is already the resolved `false`. So only an explicit `--init`
  without docker is rejected, and `--no-init` without docker is accepted
  (it is the default anyway).
- **Why the default stays off.** `docs/case-studies/issue-207/research.md`
  notes that users' own supervisors may not expect another PID 1, and that
  recovery must keep working for containers started without it. Recovery reads
  `init` from the record, so both kinds of container resume as they were
  started.
- **Process IDs.** With `--init`, `.State.Pid` is tini's host PID. tini is in the
  same cgroup as the command, so the cgroup-memory path resolution
  (`/proc/<.State.Pid>/cgroup`) is unchanged. `--status` reports tini's PID as
  `containerPid`, which is the container's PID 1, as it was before.

## Evidence

`experiments/issue-244-tini-exit-evidence.js` runs each case with and without
`--init` against a real daemon and exits 1 on any difference from the
expectations. Results from Docker 29.9.1 on this host
(`ci-logs/issue-244/tini-exit-evidence.txt`):

| Case | Without `--init` | With `--init` |
| --- | --- | --- |
| PID 1 | `sleep` (the command) | `docker-init` |
| Orphan zombies after 1.5 s | 1 | 0 |
| `exit 3` | ExitCode 3, OOMKilled false | ExitCode 3, OOMKilled false |
| Child killed by SIGSEGV | 139, false | 139, false |
| `docker kill` | 137, false | 137, false |
| `docker stop -t 2` | 137 after 2.5 s (SIGTERM ignored by PID 1, then SIGKILL) | 143 after 0.7 s (tini forwards SIGTERM) |
| Memory-limit OOM kill | blocked on this host, see below | blocked on this host, see below |

The `docker stop` row is the one visible behaviour change. Without an init, the
kernel drops a signal sent to a namespace's PID 1 when PID 1 has no handler for
it. So `--stop` on a command without a SIGTERM handler waited out the grace
period and ended with SIGKILL (137). Under tini the command gets SIGTERM and
ends at once with 143. The README and the changeset describe this.

**OOM case: blocked locally, run in CI.** This host cannot start any container
with `--memory`: its root cgroup does not delegate the memory controller
(`cgroup.subtree_control` is `cpuset cpu pids`, and `/sys/fs/cgroup/docker` is
`threaded`). runc fails with `cannot enter cgroupv2 "/sys/fs/cgroup/docker" with
domain controllers -- it is in threaded mode`, and `--cgroup-parent` does not
help. The experiment therefore also passes `$`'s own attribution code, the
same way `experiments/issue-209-docker.mjs` does: `collectExitEvidence`
(cgroup `oom_kill` delta / Docker `oom` event near `FinishedAt`), then
`resolveExitReason` and `resolveMemoryExhaustion`. It expects both runs to be
`exit=137 oom=true reason=memory-exhaustion (cgroup-oom-killer)
memoryExhausted=true`. The Linux JS CI job runs it with
`ISSUE_244_REQUIRE_OOM=1`, so a skipped OOM case fails there, and uploads the
output as the `issue-244-docker-evidence` artifact.

Why the attribution cannot change: OOM evidence in `$` is container-wide
(`State.OOMKilled`, the cgroup `oom_kill` counter, Docker's `oom` event). It
does not depend on PIDs. `isOomKillOfCommand` additionally needs a SIGKILL exit
(137) or no exit code. The OOM killer picks the command, not the
few-hundred-KiB tini, and tini then exits `128 + 9 = 137`. The `docker stop` row
shows tini's `128 + n` path working: its child died from SIGTERM, and tini
exited 143.

Tests:

- `js/test/regression-244.js` / `rust/tests/regression_244.rs`:
  - parsing: `--init`, `--no-init`, the default, the environment values,
    `--no-init` over the environment, the environment without docker,
    `--init` rejected without docker, and validating twice;
  - the `docker run` argument order, the status line, the record metadata and
    the start-block row;
  - resume and snapshot plans with and without a stored `init`, and (JS) the
    nested level of a stack;
  - real docker through the CLI: `HostConfig.Init` true, PID 1 `docker-init`,
    0 zombies against 1 without `--init`, and `--status` reports `init: true`;
    exit codes 3 and 139 the same with and without `--init`, as recorded by
    `--status`; and `docker kill` 137 / `docker stop` 143 vs 137.
- `parity/fixtures/contracts.json`: `--init` with and without `--privileged`,
  shared by `js/test/shared-golden.js` and `rust/tests/shared_golden.rs`.
