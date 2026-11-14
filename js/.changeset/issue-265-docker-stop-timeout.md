---
'start-command': minor
---

Configurable grace period between SIGTERM and SIGKILL for Docker executions (#265). Previously `--stop` always used Docker's default of 10 seconds, so a graceful-shutdown handler that needed longer was killed with exit 137.

- **`--stop <id> --stop-timeout <s>`** runs `docker stop -t <s>` for that stop.
- **`--isolated docker --stop-timeout <s>`** runs `docker run --stop-timeout <s>` (the container's own `StopTimeout`, so a plain `docker stop` and daemon shutdown honour it too). The value is recorded with the execution, shown as `[Isolation] Stop timeout: <s>s`, reused by `--resume` and forwarded to nested docker levels of an isolation stack.
- **`START_DOCKER_STOP_TIMEOUT=<s>`** sets the default for both.
- `--stop` uses the flag, then the value recorded at launch, then the environment, then Docker's 10 seconds; without any of them the docker call is unchanged (`docker stop <name>`).
- The stop report says how long the container has: `Requested graceful stop for detached docker container: <name> (SIGTERM, SIGKILL after <s>s)`, and Links Notation output adds `stopTimeout <s>`.
- Values are whole seconds (`0` stops immediately). Invalid values, `--stop-timeout` without `--stop` or a docker launch, and `--stop-timeout` on screen/tmux executions are rejected with a clear error. `--terminate` is unchanged.
