# Safe Docker command resume: issue #198

The [issue](https://github.com/link-foundation/start/issues/198), opened on
2026-10-10 at 05:42:32 UTC, describes replacement commands always copying a
stopped container's writable layer. Its complete body and empty comment list are
preserved in [data/issue-198.json](data/issue-198.json) and
[data/comments.json](data/comments.json). This fix is part of
[PR 204](https://github.com/link-foundation/start/pull/204).

## Root cause and evidence

The previous resume planner selected `docker-snapshot` whenever the caller
provided a replacement command. It committed the stopped container, launched a
successor, and retained the original. The execution reservation introduced by
issue #196 serialized requests for one execution, but two different executions
could still commit concurrently. No disk check preceded commit, and the
completion watcher knew how to remove a container but not its generated image.

The incident quoted by the issue involved four writable layers totaling roughly
92.5 GiB, concurrent commits, and an available-disk drop from 52 GB to 2 GB. These
are the issue author's observations, rather than a stress test repeated here.
The issue also links a [Sealos investigation](https://sealos.io/blog/sealos-devbox-commit-performance-optimization/)
that reports 39.14 seconds for a 1 KB incremental commit and 846.99 seconds for
its 10 GB initial commit. That study identifies expensive filesystem walking in
the containerd differ; it does not establish universal timings for every Docker
storage driver. Avoiding commit addresses both the wrapper's disk amplification
and the need to traverse the filesystem.

The minimal reproduction in
[experiments/issue-198-resume-reproduction.js](../../../experiments/issue-198-resume-reproduction.js)
loads the previously committed JavaScript planner and requests a replacement
command for a handoff-capable stopped container. The old planner returns
`commit`, `run`; the updated planner returns `start` and the lifecycle flow copies
only a small command script. The assertion fails before the change and passes
after it:

```sh
node experiments/issue-198-resume-reproduction.js --baseline=540267911984ff07ef53a8f672d4d392d6586de9
node experiments/issue-198-resume-reproduction.js
```

[Before](data/reproduction-before.txt) and [after](data/reproduction-after.txt)
logs preserve the actual results. This probe performs no Docker allocation.

## Every requirement, alternatives and implementation plan

| Requirement from the issue                                                                                             | Considered solutions                                                                                                       | Applied plan and coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run a different command in the same stopped container without copying its writable layer                               | Separate `--in-place` flag; permanent supervisor plus `docker exec`; default handoff for newly created detached containers | Add a POSIX selector to every new detached Docker launch, including relaunches and snapshot successors. Persist `commandHandoff`. Copy a quoted, readable script with `docker cp`, then `docker start` the same container. Selector and lifecycle tests preserve its ID and files and assert no commit/run/create.                                                                                                                                                                    |
| Fall back for older containers that have no selector                                                                   | Refuse old records; require migration; retain snapshot fallback                                                            | Keep the snapshot planner for legacy records. Changed caller labels also require a replacement because Docker container labels are immutable. Newly created successors gain the selector, so subsequent ordinary replacement commands use handoff.                                                                                                                                                                                                                                    |
| Read writable size before commit                                                                                       | Estimate from configured memory or image size; inspect `SizeRw`                                                            | Run `docker inspect --size --format '{{.SizeRw}}'`; reject missing, malformed or unsupported sizes. Checks happen after reservation but before any commit.                                                                                                                                                                                                                                                                                                                            |
| Check Docker data root and containerd root when using the containerd image store                                       | Check only DockerRootDir; shell out to an image-store-specific SDK; inspect Docker information and measure both roots      | Read `docker info --format '{{json .}}'`. Check DockerRootDir and, for `io.containerd.snapshotter`, the top-level root in `/etc/containerd/config.toml`, defaulting to `/var/lib/containerd`. `START_CONTAINERD_ROOT` supports a known custom root. JavaScript uses `statfs`; Rust uses `df -Pk`. Tests independently fail insufficient containerd space even when DockerRootDir has ample space.                                                                                     |
| Refuse or clearly wait when disk is below 2 × SizeRw plus reserve; report snapshot size                                | Wait indefinitely for unrelated cleanup; fail early with capacity figures                                                  | Require at least `2 * SizeRw + 10 GiB` at each distinct storage root. Refuse unknown/unobservable capacity. Emit `snapshotting N.NN GiB` with the required capacity into resume output and the session log. Boundary and low-disk tests verify refusal before commit and reservation rollback.                                                                                                                                                                                        |
| Serialize snapshot resumes across processes without holding the execution-store lock                                   | Hold the store lock; add a process-local mutex; host-wide separate lock                                                    | Reuse the cross-language atomic lock protocol at `/tmp/start-command-docker-snapshot.lock` on Unix. Hold it through preflight, commit, launch and optional predecessor cleanup; the store lock remains limited to record writes. A live local owner is not reclaimed because a long snapshot ages. Contention returns a clear retry message after a bounded acquisition attempt. Tests verify exclusion, including a second Node process, and successful reacquisition after release. |
| Opt in to remove the stopped predecessor only after a snapshot successor is running, with `docker rm` rather than `-f` | Remove every predecessor automatically; force removal; explicit `--remove-original`                                        | Extend both parsers and resume entry points with `--remove-original`. Inspect successor `.State.Running` after successful startup, then issue non-forced `docker rm original`. Retain by default, on failed startup and when the successor has already stopped. Tests verify ordering, argv and retention.                                                                                                                                                                            |
| Remove generated `start-command-resume/*` images when the existing policy removes the successor                        | Global image prune; force deletion; container-specific ownership label                                                     | Label each snapshot successor with its generated image reference. Both completion-watcher branches capture the reference, remove the container according to existing policy, then attempt non-forced `docker rmi` only for the wrapper namespace. Kept containers retain their images. Failed launches remove completed snapshots where possible. Fake-Docker watcher and real-Docker tests verify removal.                                                                           |
| Correct the misleading same-container cleanup hint                                                                     | Retain the old text now that new containers support handoff; make legacy behavior explicit                                 | Update both normal hints and log-embedded hints in JavaScript and Rust to explain that legacy containers snapshot into a new container. Resume output explicitly reports the selected mode and names.                                                                                                                                                                                                                                                                                 |
| Apply the change throughout the codebase and preserve existing features                                                | JavaScript-only fix; patch one resume callsite                                                                             | Implement JavaScript first and mirror the selectors, planner, preflight, lock, original cleanup, watcher cleanup and automatic recovery in Rust. Keep live resource limits, multi-network create/connect/start, execution UUID, launch reservations, rollback, log continuity and existing cleanup policies. Focused regression suites include issues 171, 174, 176, 187 and 193.                                                                                                     |

The temporary selector script uses a path directly in the container root rather
than `/tmp`, which can be a mounted or temporary filesystem. Its shell-quoted
command preserves single quotes, dollar signs and compound commands; mode 0644
allows a configured non-root container user to read the script. Direct shell
invocations preserve positional argv; compound commands use a shell script. Auto
shell preference is resolved inside the existing container in the same order as
initial launch (bash, zsh, sh), without launching a probe container. `exec` keeps
the real task as PID 1. Automatic kill recovery overwrites the same selector when
needed, so a previous manual replacement cannot suppress `--recovery-command`.
Copy or start failures restore the prior command best-effort and restore the
stored reservation.

Caller labels are merged by key, persisted and reapplied on replacement
containers. Root-session attribution is retained across repeated successors.
In-place reuse keeps immutable Docker labels from container creation, while the
execution record increments its resume counter. See the
[issue #199 case study](../issue-199/README.md) for that constraint.

## Primary research and existing components

[Docker `cp`](https://docs.docker.com/reference/cli/docker/container/cp/)
explicitly supports stopped containers and preserves file permissions. It is the
existing component needed for handoff. A permanently running supervisor would
change task lifetime and completion tracking;
[Docker `exec`](https://docs.docker.com/reference/cli/docker/container/exec/)
requires a running primary process, so it cannot directly replace a command in a
stopped container.

[Docker daemon storage documentation](https://docs.docker.com/engine/daemon/)
confirms fresh Engine 29 installations use the containerd image store and that
`data-root` does not relocate containerd's separate storage. Checking only
DockerRootDir can therefore inspect the wrong filesystem. The two-root preflight
uses the documented default and custom containerd root configuration. Docker's
[commit documentation](https://docs.docker.com/reference/cli/docker/container/commit/)
also explains that mounted-volume data is outside committed images; existing
mount and network forwarding must remain in the successor launch.

The repository's `LockManager` already publishes fully written lock records
atomically and shares ownership tokens between JavaScript and Rust. Reusing it
on a separate global path avoids a new dependency and long execution-store
transactions. Existing alternatives include
[proper-lockfile](https://github.com/moxystudio/node-proper-lockfile), whose
heartbeat model supports long-held locks, and
[fs-ext](https://github.com/baudehlo/node-fs-ext), which exposes `flock` and `fcntl`
through native bindings. Either would require a compatible native protocol or
additional dependencies; neither replaces the need for disk preflight or a
stopped-container command selector.

## Verification and limits

The focused JavaScript run covers 176 passing tests, including the final
root-session and direct/compound/auto-shell regressions; its output is preserved in
[data/js-focused.log](data/js-focused.txt). A subsequent run of the three new
issue-specific suites passes all 17 tests, including the second-process lock
probe; see [data/js-final-focused.log](data/js-final-focused.txt). The final
native run passes 1,026 tests across 53 suites with no failures and two ignored
tests, including 279 library tests. New native coverage includes handoff,
direct/compound/auto-shell behavior, root-session attribution, changed labels,
disk refusal and non-forced predecessor removal. Full verification evidence is
tracked in the [umbrella case study](../issue-203/README.md); an earlier
276-test library run is preserved in
[data/rust-lib-tests.log](data/rust-lib-tests.txt).

The real-Docker probe
[experiments/issue-198-docker-smoke.js](../../../experiments/issue-198-docker-smoke.js)
uses Alpine 3.23, tiny marker files, finite 120-second commands and a 128 MiB
in-container virtual-memory limit. It verifies the same container ID and
preserved files with zero snapshot commands; a real legacy snapshot after disk
preflight; predecessor removal only after startup; handoff on the successor; and
both container and image removal through the generated completion watcher.
[Structured results](data/docker-smoke-results.json) and
[the full log](data/docker-smoke.txt) record those observations. Cleanup runs in
`finally`; no probe containers or images remain.

This daemon uses `fuse-overlayfs`, so the separate containerd filesystem checks
are verified with deterministic mocks. An initial attempt to apply Docker
memory/CPU/PID cgroup limits was refused because the host's cgroupv2 Docker
hierarchy is threaded; [the failure log](data/docker-cgroup-probe.txt) is retained.
The successful probe remains bounded through its shell limit and finite inputs.
It does not reproduce the issue's large-disk incident.

Preflight observes local daemon storage. If a remote daemon or Docker Desktop VM
stores data at inaccessible paths, it fails closed instead of starting a snapshot
whose capacity cannot be checked. A 10 GiB reserve and 2 × SizeRw are conservative
operational checks, not an assurance against unrelated host writes after the
check. Only wrapper snapshot processes share this lock. `START_SNAPSHOT_LOCK`
must name one common path if overridden. Non-forced image cleanup can retain an
image that Docker reports is still in use; it never prunes unrelated images or
forces deletion of shared data. Original containers remain available unless the
caller explicitly selects `--remove-original`.
