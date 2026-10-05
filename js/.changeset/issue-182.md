---
'start-command': patch
---

Record the container's cgroup v2 memory counters for detached Docker executions: the completion watcher samples `memory.max`, `memory.peak` and the `memory.events` `oom`/`oom_kill` counters every second (and once more after the container exits, since the cgroup disappears with it). They are written as a `Memory:` line after the container post-mortem, stored as `cgroupMemory` (`limitBytes`, `peakBytes`, `oomEvents`, `oomKills`) and shown by `--status` as `Cgroup Memory:` with a note telling a container-limit OOM (`oom_kill == oom`) from a host-wide or parent-cgroup OOM (`oom_kill > oom`). A non-zero `oomKills` explains a SIGKILL or unknown exit as a cgroup OOM kill, and each `--on-kill-resume` `recoveryHistory` entry notes `oomEvents`/`oomKills` of the killed run. Hosts without cgroup v2 or with a remote `DOCKER_HOST` record nothing.
