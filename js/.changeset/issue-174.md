---
'start-command': patch
---

Never finalize a still-running detached Docker container as a success. `docker logs -f` also returns when its own write to the log fails (ENOSPC) or when dockerd restarts, so the completion watcher now asks `docker inspect -f '{{.State.Running}}'` and keeps waiting with `docker wait` until the container really exits. If the watcher still sees a running container, it notes this in the log and leaves the container and the execution record alone: no `docker rm -f`, no `Exit Code: 0` footer, and no `executed` status. A zero `FinishedAt` (`0001-01-01T00:00:00Z`) combined with an exit code of 0 is recorded as `-1` with `exitReason: watcher-lost-container`, not as a success. A child process that is killed by a signal now reports `128+n` (for example `137` for SIGKILL) instead of `0` in `runWithNodeSpawn`, `runAsIsolatedUser` and the command-stream wrapper.
