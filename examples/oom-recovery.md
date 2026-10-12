# Recover a Docker task with a larger memory limit

Run a workload with an initial limit and a larger limit available for one
automatic recovery:

```sh
$ --isolated docker --detached --memory 128m --on-kill-resume 1 --on-kill-resume-memory 256m -- your-workload
```

When a recent Docker OOM event accompanies exit 137, recovery updates the memory
limit before restarting. An old child OOM followed by ordinary exit 1 does not
trigger recovery. Query the printed execution UUID:

```sh
$ --status <execution-uuid> --output-format json
```

Each archived attempt includes its own reason and memory observation. For
example, an OOM attempt reports `memory-exhaustion (cgroup-oom-killer)` and
`memoryExhausted: true`; a later successful attempt retains exit 0.

For collection diagnostics, launch with `START_DEBUG=1`. A finite Linux Docker
reproduction with explicit memory, process and CPU bounds is available as
`node experiments/issue-209-docker.mjs` from the repository root.
