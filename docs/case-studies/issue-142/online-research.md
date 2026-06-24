# Online Research

External references reviewed for Docker stop behavior:

| Source                                                                                      | Relevant fact                                                                                                                                                     | Use in solution                                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Docker CLI `container stop`, <https://docs.docker.com/reference/cli/docker/container/stop/> | `docker stop` stops running containers, sends the configured stop signal first, and sends `SIGKILL` after the timeout if needed.                                  | Docker `--stop` should use `docker stop` rather than a raw custom signal.                        |
| Docker CLI `container kill`, <https://docs.docker.com/reference/cli/docker/container/kill/> | `docker kill` sends `SIGKILL` by default, or a custom signal when `--signal` is provided; a custom signal may be non-terminal depending on the container process. | `--terminate` can remain `docker kill`, but `--stop` should avoid `docker kill --signal=SIGINT`. |
| Dockerfile `STOPSIGNAL`, <https://docs.docker.com/reference/dockerfile/#stopsignal>         | `STOPSIGNAL` defines the signal sent when Docker stops a container; the default is `SIGTERM` if not defined.                                                      | Using `docker stop` respects image and container stop-signal configuration.                      |

Related components and libraries considered:

- Docker CLI remains the source of truth for container lifecycle control.
- The existing detached Docker completion watcher already follows logs, waits for
  container exit, inspects exit code, and applies cleanup policy after the
  container exits.
- No additional process supervisor library is needed for this bug.
