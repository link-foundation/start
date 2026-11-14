# Issue #265: configurable grace period for `--stop` on docker executions

[Issue #265](https://github.com/link-foundation/start/issues/265) reports that
`$ --stop <uuid>` on a detached docker execution gives the program only
Docker's default 10 seconds between `SIGTERM` and `SIGKILL`. A shutdown handler
that uploads a large log was killed with exit code 137. The issue text is in
`issue-265.json`.

## Root cause

Both editions built the stop command without a timeout:

- JavaScript, `js/src/lib/execution-control.js`: `args: ['stop', sessionName]`
- Rust, `rust/src/lib/execution_control.rs`:
  `args: vec!["stop".to_string(), session_name.to_string()]`

Containers were also started without `docker run --stop-timeout`. With neither
set, `docker stop` uses `Config.StopTimeout`, which defaults to 10 seconds.

### Reproduction

`experiments/issue-265/repro.sh` starts a container whose `TERM` handler needs
15 s and then stops it with `$ --stop`. Before the fix
(`experiments/issue-265/repro-before.log`):

```text
  method DOCKER_STOP
  message "Requested graceful stop for detached docker container: issue-265-repro-11415"
--stop returned after 10s
exit code: 137
ready
cleanup-start
```

After the fix, with `--stop-timeout 30`
(`experiments/issue-265/repro-after.log`):

```text
  method DOCKER_STOP
  stopTimeout 30
  message "Requested graceful stop for detached docker container: issue-265-repro-14029 (SIGTERM, SIGKILL after 30s)"
--stop returned after 16s
exit code: 0
cleanup-done
```

`repro-launch.log` shows the same result when the value is given at launch.
`docker inspect` reports `StopTimeout: 30`, so a plain `docker stop` honours it
too.

## Fix

This implements every option the issue suggests, in JavaScript and Rust:

| Input                                         | Docker call                                 |
| --------------------------------------------- | ------------------------------------------- |
| `$ --stop <id> --stop-timeout <s>`            | `docker stop -t <s> <container>`            |
| `$ -i docker --stop-timeout <s> -- <command>` | `docker run --stop-timeout <s>` (recorded)  |
| `START_DOCKER_STOP_TIMEOUT=<s>`               | default for both                            |
| none of the above                             | `docker stop <container>` (unchanged, 10 s) |

`--stop` resolves the grace period from these sources, in order:

1. Its own `--stop-timeout`.
2. The value recorded at launch, which is the container's own `StopTimeout`.
3. `START_DOCKER_STOP_TIMEOUT`.
4. Docker's 10 seconds.

The report always names the grace period: `(SIGTERM, SIGKILL after Ns)`, and
Links Notation output adds `stopTimeout N`.

The value given at launch is also:

- shown as `[Isolation] Stop timeout: Ns`
- stored in the execution record as `stopTimeout`
- reused by `--resume`
- forwarded to nested docker levels of an isolation stack

Values are whole seconds; `0` means `SIGKILL` right after `SIGTERM`. These are
rejected with a clear error:

- invalid values from the flag or the environment
- `--stop-timeout` without `--stop` or a docker launch
- `--stop-timeout` on screen or tmux executions

`--terminate` is unchanged and still runs `docker kill`.

## Tests

- `js/test/regression-265.js` and `rust/tests/regression_265.rs` cover:
  - parsing and environment defaults
  - `docker run` argument order and metadata
  - the `-t` argument and its precedence
  - errors and the report text
  - `--resume`
  - two real-docker runs: a slow handler that finishes inside a 5 s launch
    value (exit 0), and `--stop --stop-timeout 1` that kills sooner than the
    default (exit 137 well under 10 s)
- `parity/fixtures/contracts.json` holds shared parsing and isolation-argument
  goldens that both editions check.
