# Solution Options

## Option A: Native backend control commands (chosen)

Use the tracked `sessionName` and `isolated` backend to call the native tool:

| Backend | `--stop`                                | `--terminate`                    |
| ------- | --------------------------------------- | -------------------------------- |
| screen  | `screen -S <session> -X stuff <Ctrl-C>` | `screen -S <session> -X quit`    |
| tmux    | `tmux send-keys -t <session> C-c`       | `tmux kill-session -t <session>` |
| docker  | `docker stop <container>`               | `docker kill <container>`        |

Advantages:

- Matches how users already control these systems.
- Does not require start-command to keep a live supervisor process.
- Works by UUID or session name because records already store session names.
- Keeps graceful and immediate termination semantics separate.
- Uses Docker's container stop lifecycle for `--stop`, including the configured
  stop signal and forced-kill fallback.

Trade-offs:

- Process ID discovery remains best-effort and depends on installed backend
  tools.
- SSH control is not implemented until the stored record contains enough remote
  process metadata to do it safely.

## Option B: Send POSIX signals directly to stored PIDs

Use `kill -INT <pid>` and `kill -KILL <pid>` against the stored record PID.

Rejected because detached records often store the wrapper PID, while the actual
long-running process belongs to screen, tmux, or Docker after the wrapper exits.
Direct local signals would be unreliable and cannot target Docker or remote SSH
children correctly.

## Option C: Add a persistent supervisor daemon

Keep a start-command daemon alive to own every child process and expose control
APIs.

Rejected for this issue because it is a much larger architecture change. Native
backend controls solve the reported behavior using data already present in the
execution store.

## Option D: Implement only status PID enrichment

Expose process IDs but leave control commands for a later issue.

Rejected because the issue explicitly asks for `--stop` and `--terminate`.
Status enrichment is useful, but it does not let the user act on the detached
execution from the CLI.
