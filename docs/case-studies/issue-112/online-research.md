# Online Research

External references reviewed for backend semantics:

| Source                                                                                      | Relevant fact                                                                                                 | Use in solution                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GNU Screen manual, <https://www.gnu.org/software/screen/manual/screen.html>                 | Screen supports remote commands such as `stuff` and `quit`.                                                   | `--stop` injects CTRL+C with `screen -S <session> -X stuff`, while `--terminate` uses `quit`.                |
| tmux manual, <https://man.openbsd.org/tmux.1>                                               | tmux supports `send-keys`, `kill-session`, and format variables such as `pane_pid`.                           | `--stop` uses `tmux send-keys ... C-c`, `--terminate` uses `kill-session`, and status can collect pane PIDs. |
| Docker CLI `container stop`, <https://docs.docker.com/reference/cli/docker/container/stop/> | Docker sends the configured stop signal, defaults to `SIGTERM`, and escalates to `SIGKILL` after the timeout. | `--stop` uses `docker stop` so detached Docker isolation follows Docker's container stop lifecycle.          |
| Docker CLI `container kill`, <https://docs.docker.com/reference/cli/docker/container/kill/> | Docker sends `SIGKILL` by default and supports `--signal` for custom signals such as `SIGINT`.                | `--terminate` uses default `docker kill`; `--stop` avoids raw custom-signal delivery for Docker.             |
| Linux `signal(7)`, <https://man7.org/linux/man-pages/man7/signal.7.html>                    | `SIGINT` is the interrupt signal; `SIGKILL` is a kill signal and cannot be caught, blocked, or ignored.       | Defines the graceful/immediate behavior split.                                                               |
| Linux `pgrep(1)`, <https://man7.org/linux/man-pages/man1/pgrep.1.html>                      | `pgrep -P` restricts matches to children of a parent PID.                                                     | Status enrichment follows descendant process IDs from screen/tmux roots.                                     |

Related components and tools considered:

- Native GNU Screen commands are the source of truth for screen sessions.
- Native tmux commands are the source of truth for tmux sessions and pane PIDs.
- Native Docker CLI commands are the source of truth for container control and
  host-side container process IDs.
- A new supervisor daemon was considered but rejected as unnecessary for this
  issue because existing backend CLIs already expose the required controls.
