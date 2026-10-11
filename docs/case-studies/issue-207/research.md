# Root cause and primary-source research

The monitor initially reads only launch flags. HostConfig limits applied after
launch never enter its policy state, and initial-state reconstruction overwrites
the persisted base. At 4 busy cores on a 6-CPU daemon, the old default trigger
requires 5.7 cores. A permissive trigger eventually applies 2 CPUs, then restores
6 instead of 4. Resume restoration independently used launch flags and therefore
needed the observed sidecar base too.

The monitor holds a lifetime file lock. Signal zero succeeds for zombie processes
and unrelated processes with a reused PID. The old watcher launches only once,
and a publication error escapes the entire loop. These are independent failure
paths: merely improving one cannot satisfy all acceptance criteria.

The new lock regression also exposed inode reuse: an old JavaScript owner could
remove a replacement lock with the same inode number. New JavaScript locks use
a random ownership token on release, matching Rust's existing token protocol.
Another focused regression protects a remembered base after restarting an
observing monitor whose last lift was clamped by a smaller daemon CPU count.

Primary references checked on 2026-10-11:

- [Docker update](https://docs.docker.com/reference/cli/docker/container/update/)
  documents dynamic updates and both CPU formats. Existing resource parsers and
  update argument helpers already support NanoCPUs and period/quota; reuse them.
- [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
  describes fractional CPU limits and quota/period equivalence. Usable capacity
  is the lower of the current finite quota and daemon CPU count.
- [Linux proc stat](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)
  defines zombie state and process start-time identity (field 22). The process
  name may include spaces/parentheses, so parse after the final closing parenthesis.
- [Linux process status](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html)
  independently documents Z/X states. This distinguishes a dead owner from a
  running owner without depending on signal-zero alone.
- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)
  uses periodic mtime updates and stale thresholds and reports compromised
  locks. Replacing the shared JS/Rust hard-link protocol would add migration
  complexity; process birth identity and legacy CPU-owner markers solve this
  issue while preserving compatibility. A time-only lease can evict a live
  monitor blocked in a Docker call; no such unsafe eviction is introduced.
- [dockerode](https://github.com/apocas/dockerode) exposes Docker inspection,
  statistics and updates. It could avoid repeated CLI startup, but adding a new
  transport requires matching remote/context/auth behavior and Rust transport.
- [Bollard](https://github.com/fussybeaver/bollard) supplies the equivalent Rust
  daemon client and statistics streams. It remains an alternative for a future
  transport migration, not a prerequisite for fixing these adapters.
- [Tini](https://github.com/krallin/tini) reaps zombies and forwards signals.
  Docker `--init` can reduce zombie accumulation, but users' supervisors may not
  use it; recovery must work in existing containers. The watcher supervisor
  waits/reaps its own child and old zombie locks can still be reclaimed.

Alternatives and limits:

1. One delayed HostConfig read misses subsequent supervisor updates; inspect each
   tick instead. Reuse the current CPU representation for updates. A different
   external quota ends the current penalty and starts a fresh observation window.
2. Detect child death by polling signal zero plus proc state, or directly wait
   for it. Direct wait naturally reaps the child and restarts after nonzero exits
   with a short backoff. Both attached and detached paths use the same snippet.
3. Before applying a cap, persist its intended state/base. A write failure leaves
   Docker unchanged. After a crash between persistence and Docker update, fresh
   inspection reconciles the intended state with actual HostConfig.
4. Catch tick failures, discard incomplete sample coverage and retry. Ordinary
   termination best-effort restores an owned cap on the same execution attempt.
   SIGKILL cannot execute cleanup: supervision or resume-all supplies recovery.
5. Preserve existing opt-in flags, full weighted windows, strict quiet threshold,
   daemon resize semantics, attempt scoping, logs/stats filtering and release
   automation. No new runtime dependency or output flag is necessary.

No process can restore a quota during an indefinite Docker outage, nor after all
supervisors have been killed until supervision is reattached. That limitation is
explicit; the required resumed monitor does recover and collect a fresh window.
