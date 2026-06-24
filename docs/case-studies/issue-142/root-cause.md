# Root Cause

Detached Docker `--stop` used the wrong backend primitive.

The execution-control helpers treated all graceful stop requests as interrupt
signals. That works for terminal multiplexers:

- screen can receive a Ctrl+C byte through `screen -S <session> -X stuff`.
- tmux can receive Ctrl+C through `tmux send-keys`.

Docker containers have a different lifecycle. The previous Docker mapping was:

```text
docker kill --signal=SIGINT <container>
```

That command only sends a specific signal to the container's main process. It
does not run Docker's container stop flow, does not honor the container's
configured stop signal, and does not guarantee termination if the process ignores
or does not receive `SIGINT`.

The issue transcript demonstrated this directly: the CLI reported `method
SIGINT` and `signal-sent`, but the container stayed `executing`. The successful
manual workaround was Docker's native stop operation:

```text
docker stop <containerId>
```

The same incorrect mapping existed in both implementations:

- JavaScript: `js/src/lib/execution-control.js`
- Rust: `rust/src/lib/execution_control.rs`

The previous test coverage verified screen stop and Docker terminate behavior,
but did not verify Docker stop behavior.
