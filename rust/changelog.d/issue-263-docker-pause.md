---
bump: minor
---

### Changed

- `--pause <id>` / `--unpause <id>` freeze and thaw a detached Docker execution in place (#263), mirroring the JavaScript implementation:
  - `docker pause`/`docker unpause` keep the same container, process (PID), execution UUID, record and log; no new execution or recovery is created. Docker calls use argument arrays and a 30 second timeout.
  - CPU is released while memory and disk stay allocated (`--stop` frees RAM). The record keeps `paused`, `pausedAt`, `pauseCount`, `pausedBy` and `pauseReason` (`--pause-reason`, `--paused-by`), and unpause records `pauseEndedBy`.
  - Repeated pause/unpause is a no-op; stopped or removed containers fail with a pointer to `--status` and `--resume`; screen and tmux are refused.
  - `--status` reports `dockerState`, `paused` and `pausedAt`, a paused execution stays `executing`, and `--list --running` includes it. The recorded pause is reconciled with `docker inspect` after daemon restarts, reboots or external changes, and a removed container shows `removed`.
  - Paused executions are never attached to, resumed, resumed by `--resume-all`, cleaned up or completed by the watcher; `--stop`/`--terminate` clear the pause as an intentional stop, so `--on-kill-resume` does not restart it.
  - Pause/unpause reports, errors, docker calls and saved records are held to the same shared golden contracts as JavaScript (`pause-control` in `parity/fixtures/contracts.json`).

### Fixed

- Links Notation reports of `--pause`, `--unpause`, `--stop` and `--terminate` list `processIds` (`wrapperPid`, `containerId`, `containerPid`, …) and `resources` (`cpu`, `memory`, `disk`) in the same order as JavaScript instead of alphabetically.
