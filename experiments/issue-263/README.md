# Issue #263 experiments: `--pause` / `--unpause`

- `smoke-pause.sh` drives the real CLI against a local Docker daemon:
  launch a detached container, pause it (twice, idempotent), query
  `--status`/`--list --running`, try `--attach`/`--resume`/`--resume-all`/
  `--cleanup` on the paused container, unpause it (twice), pause again, stop it,
  then pause/unpause the exited container and pause a screen session.
  `smoke-output.log` is a captured run.
- Observed facts (Docker 29.9.1, cgroup v2):
  - A paused container reports `.State.Status=paused`, `.State.Running=true`,
    `.State.Paused=true`; the container PID is unchanged across
    pause/unpause (26017 before and after in `smoke-output.log`).
  - Because `.State.Running` stays `true`, the detached watcher
    (`while running; do docker wait; done`) keeps waiting and never completes
    a paused execution.
  - `docker stop` on a paused container delivers SIGTERM and thaws it, so a
    graceful stop still runs the process's TERM handler:
    `docker run -d alpine sh -c 'trap "exit 0" TERM; while true; do sleep 1; done'`
    → `docker pause` → `docker stop -t 5` exits with code 0, the same as for a
    running container. (In the smoke run the command ran as PID 1 `sh`
    without a trap, which ignores SIGTERM, hence exit 137 after the timeout.)
  - `docker rm` without `-f` refuses a paused container.
