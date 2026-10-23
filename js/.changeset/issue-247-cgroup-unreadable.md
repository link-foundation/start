---
'start-command': patch
---

Stop the Docker cgroup sampler when the counters can never be read (#247). On hosts whose containers have no `memory.events` (the `memory` controller is not delegated, e.g. a root `cgroup.subtree_control` of `cpuset cpu pids`) and whose local cgroup is hidden, the sampler started one `docker exec` and one `docker inspect -f {{.State.Running}}` every interval for the whole life of the task without ever recording a sample. Exit 3 (unreadable counters) from the long-lived stream or from the per-round read now records the reason and stops sampling, as a missing `sh` (exit 126/127) already did; the post-mortem reports `Memory:     unavailable (local cgroup unavailable; Docker exec exit=3: private cgroup v2 counters unreadable)` instead of the last round's error. Other failed rounds are still retried, but each one doubles the wait, up to 60 s (or the interval, if longer); a sample restores the interval. The completion watcher (`docker wait`) still finishes the run.

Attached `--isolated screen` runs no longer report a failed command as exit 0 when `screen -dmS` returns before `screen -ls` lists the new session. A session missing from `screen -ls` now counts as finished only once its exit-code file is written, or after 20 polls (about 2 s) without the session.
