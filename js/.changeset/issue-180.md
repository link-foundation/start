---
'start-command': patch
---

Stop reporting `exitReason: memory-exhaustion (cgroup-oom-killer)` and `memoryExhausted: true` (`Docker reported State.OOMKilled=true`) for executions that exited 0, 1 or any other ordinary code while Docker's sticky `OOMKilled` flag was set. The flag is container-wide (moby/moby#43564): it turns on when _any_ process in the container is OOM-killed, such as a `rustc` child under `cargo test`, and stays on until the next start. It now counts as the exit reason only when the command itself died by SIGKILL (exit 137) or its exit code is unknown, the same rule `--on-kill-resume` uses since #178. `oomKilled: true` is still reported. A stale cgroup reason stored by an older version is dropped by `--status`. An attached container kept after a child OOM kill now says `Docker reports a process in it was OOM-killed`.
