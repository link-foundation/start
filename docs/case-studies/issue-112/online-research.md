# Online Research

External references reviewed for backend semantics:

| Source                                                                                      | Relevant fact                                                                                           | Use in solution                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GNU Screen manual, <https://www.gnu.org/software/screen/manual/screen.html>                 | Screen supports remote commands such as `stuff` and `quit`.                                             | `--stop` injects CTRL+C with `screen -S <session> -X stuff`, while `--terminate` uses `quit`.                |
| tmux manual, <https://man.openbsd.org/tmux.1>                                               | tmux supports `send-keys`, `kill-session`, and format variables such as `pane_pid`.                     | `--stop` uses `tmux send-keys ... C-c`, `--terminate` uses `kill-session`, and status can collect pane PIDs. |
| Docker CLI `container kill`, <https://docs.docker.com/reference/cli/docker/container/kill/> | Docker sends `SIGKILL` by default and supports `--signal` for custom signals such as `SIGINT`.          | `--stop` uses `docker kill --signal=SIGINT`; `--terminate` uses default `docker kill`.                       |
| Linux `signal(7)`, <https://man7.org/linux/man-pages/man7/signal.7.html>                    | `SIGINT` is the interrupt signal; `SIGKILL` is a kill signal and cannot be caught, blocked, or ignored. | Defines the graceful/immediate behavior split.                                                               |
| Linux `pgrep(1)`, <https://man7.org/linux/man-pages/man1/pgrep.1.html>                      | `pgrep -P` restricts matches to children of a parent PID.                                               | Status enrichment follows descendant process IDs from screen/tmux roots.                                     |

Related components and tools considered:

- Native GNU Screen commands are the source of truth for screen sessions.
- Native tmux commands are the source of truth for tmux sessions and pane PIDs.
- Native Docker CLI commands are the source of truth for container control and
  host-side container process IDs.
- A new supervisor daemon was considered but rejected as unnecessary for this
  issue because existing backend CLIs already expose the required controls.
