---
'start-command': minor
---

`--pause <id>` / `--unpause <id>` freeze and thaw a detached Docker execution in place (#263).

- **Same execution:** `docker pause` (cgroup freezer) keeps the container, its process (same PID), the execution UUID, record and log; `docker unpause` lets the same process continue. No new execution, attempt or recovery is created. Docker is called with argument arrays and a 30 second timeout.
- **Resources:** CPU is released while memory and disk stay allocated; `--stop` frees the RAM. Reports include the resource state and container PID.
- **Record:** `paused`, `pausedAt`, `pauseCount`, `pausedBy` and `pauseReason` (`--pause-reason`, `--paused-by`); unpause clears the pause and records `pauseEndedBy`. Pausing an already paused container or unpausing a running one is a no-op; stopped or removed containers fail with a pointer to `--status` and `--resume`. screen and tmux sessions are refused.
- **Status:** `--status` reports `dockerState`, `paused` and `pausedAt`; a paused execution stays `executing` and `--list --running` includes it. The recorded pause is reconciled with `docker inspect`, so a daemon restart, reboot or external `docker unpause`/`docker rm` never leaves a stale `paused: true`, and a removed container shows `removed`.
- **Guards:** a paused execution is never attached to, resumed (no snapshot), resumed by `--resume-all` (skipped with a reason), cleaned up or completed by the watcher. `--stop`/`--terminate` clear the pause and count as an intentional stop, so `--on-kill-resume` does not restart it.
- **Parity:** the JavaScript and Rust pause/unpause paths are held to shared golden contracts (`pause-control` in `parity/fixtures/contracts.json`) covering reports in every output format, errors, docker calls and the saved record.
