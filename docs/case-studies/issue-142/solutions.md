# Solution Options

## Option A: Use `docker stop` for Docker `--stop` (chosen)

Map detached Docker stop control to:

```text
docker stop <container>
```

Keep immediate termination mapped to:

```text
docker kill <container>
```

Advantages:

- Matches the workaround from the issue.
- Uses Docker's documented stop lifecycle.
- Honors Dockerfile `STOPSIGNAL` and container `--stop-signal` configuration.
- Allows Docker to force-kill the container after the stop timeout.
- Reuses the existing completion watcher for logs, exit-code lookup, and cleanup.
- Requires only a small backend-specific control mapping change.

Trade-offs:

- `docker stop` can block until Docker's stop timeout expires. That is expected
  for graceful stop behavior; users still have `--terminate` for immediate kill.

## Option B: Keep `docker kill --signal=SIGINT` and add polling

After sending `SIGINT`, poll `docker inspect` and escalate if the container is
still running.

Rejected because it recreates part of Docker's stop lifecycle incorrectly and
still ignores configured stop-signal behavior.

## Option C: Send `SIGTERM` with `docker kill --signal=SIGTERM`

Change only the signal from `SIGINT` to `SIGTERM`.

Rejected because it still bypasses Docker's `docker stop` timeout and
configuration semantics.

## Option D: Use `docker rm -f`

Force-remove the container for `--stop`.

Rejected because it collapses graceful stop and immediate termination semantics.
The existing `--terminate` command already exists for forceful behavior.
