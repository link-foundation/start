---
bump: minor
---

### Added

- Configurable grace period between SIGTERM and SIGKILL for Docker executions (#265), mirroring the JavaScript implementation. Previously `--stop` always used Docker's default of 10 seconds, so a graceful-shutdown handler that needed longer was killed with exit 137.
  - `--stop <id> --stop-timeout <s>` runs `docker stop -t <s>` for that stop.
  - `--isolated docker --stop-timeout <s>` runs `docker run --stop-timeout <s>`; the value is recorded with the execution, shown as `[Isolation] Stop timeout: <s>s` and reused by `--resume`.
  - `START_DOCKER_STOP_TIMEOUT=<s>` sets the default for both.
  - `--stop` uses the flag, then the value recorded at launch, then the environment, then Docker's 10 seconds; without any of them the docker call is unchanged (`docker stop <name>`).
  - The stop report says `Requested graceful stop for detached docker container: <name> (SIGTERM, SIGKILL after <s>s)`, and Links Notation output adds `stopTimeout <s>`.
  - Invalid values, `--stop-timeout` without `--stop` or a docker launch, and `--stop-timeout` on screen/tmux executions are rejected. `--terminate` is unchanged.
  - New public API: `docker_stop_timeout`, `get_control_command_with_options`, `control_execution_with_options`, `control_execution_with_runner_and_options` and `ControlOptions`.
