# One long-lived `docker exec` per cgroup sampler

[Issue #242](https://github.com/link-foundation/start/issues/242) reports that
after #239 the Docker cgroup sampler still pays the full per-sample cost when
the task container's cgroup is not readable where `$` runs. That is the usual
case with a mounted `docker.sock` (link-assistant/hive-mind). In that case every
round started a new `docker exec` into the task container and a
`docker inspect -f '{{.State.Running}}'`. The full issue is in `issue.json`.

## Root cause

`buildCgroupSamplerStartSnippet` / `build_cgroup_sampler_start_snippet` had one
loop body for every setup:

1. Read the local cgroup, if `__start_command_cgroup_dir` found one.
2. Otherwise, with `CgroupnsMode=private`, run
   `docker exec NAME sh -c '<functions>; __start_command_cgroup_read /sys/fs/cgroup'`.
   Inside the task container that is one `sh`, three `cat` and two
   `printf | sed` pipelines, all counted against the task's own CPU limit.
3. Whenever the local `memory.events` was not readable, ask Docker for
   `{{.State.Running}}`, even right after a successful remote read.

With the 5 s default from #239, that is 12 `docker exec` and 12
`docker inspect` calls per minute per task, plus a `runc` exec in the shim for
each exec. The issue measured these rates on a 6-CPU host (0.37.8, 1 s interval).

## What changed (JavaScript first, Rust byte-identical)

| Requirement from the issue | Implementation |
| --- | --- |
| One long-lived exec per sampler in the fallback path | With no local cgroup and a private namespace, the sampler starts `ticker \| docker exec -i NAME sh -c "$STREAM" start-command-cgroup-stream /sys/fs/cgroup` once. The host ticker writes one newline per interval. The exec's stdout is piped into a reader subshell that records each line into the same sample file, using the same `mv` and the same OOM-delta timing as before. |
| Shell builtins instead of `cat`/`sed` inside the container | `buildCgroupStreamScript` / `build_cgroup_stream_script` waits for a tick with `read` and reads `memory.events`, `memory.max` and `memory.peak` with `read`. Pacing comes from the host, so the container starts no process at all per interval, not even `sleep`. |
| The exec ends when the container stops and replaces the liveness probe | A successful sample (local or streamed) proves the container is running. `{{.State.Running}}` is asked only after a round without a sample, or when the stream ends. |
| Fall back to today's per-round exec if the stream cannot start | A stream that ends without any sample falls back to the old per-round exec from the next round on. Exit 126/127 (no `sh` in the image) records the reason and stops, because a per-round exec cannot succeed either. |
| Drop or thin out the per-round `docker inspect -f {{.State.Running}}` | It is gone while samples arrive. A readable local cgroup now never starts a remote exec either: the old one-off exec after the local cgroup disappeared is replaced by the liveness probe. |
| Allow turning sampling off | `START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS=off` (any case) writes `sampling disabled by START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS=off` as the reason and exits. The post-mortem prints `Memory: unavailable (sampling disabled …) memory.limit=… (HostConfig)`. `0` and invalid values still fall back to `5`. |
| No behaviour change for callers | The sample format (`<max> <peak> <oom> <oom_kill> <changed> <at> <dir>`), the stop snippet, the temp files and the reason file are unchanged. The #209 trade-off is unchanged: the interval stays the same. |

Other details:

- **Stopping the sampler.** While the stream runs, the sampler has a
  `trap … TERM` that kills and reaps the reader. The stop snippet's `kill` +
  `wait` therefore stops both. On the next tick the `docker` client fails to
  write the answer and exits. dockerd then closes the exec's stdin, the
  in-container `read` sees end of input, and the loop exits. The ticker ends on
  its next write.
- **Why ticks instead of an in-container `sleep`.** The first version of this
  change looped with `sleep "$interval"` inside the container. On the real
  daemon that loop outlived a stopped sampler: dockerd keeps reading an exec's
  output after its client is gone, so the in-container `printf` never failed
  (`ci-logs/issue-242/real-docker-sleep-paced-stream.txt`). With `-i`, the
  exec's stdin closes when the client goes away, so the loop cannot outlive
  the sampler. As a side effect the per-interval `sleep` in the container is
  gone. The ticker runs in the background inside the pipeline. If the exec
  fails at once (no `sh`), its exit code reaches the reader without waiting
  for the ticker's sleep.
- **Recording from the reader subshell.** `__scs_record` no longer keeps the
  previous `oom_kill` in shell variables. It reads the previous counter and
  time back from the sample file with the `read` builtin, so the reader
  subshell and the sampler record the same way.
- **The in-container loop never busy-loops.** It blocks in `read` between
  ticks. It exits 3 on unreadable counters and ends quietly (exit 0) at end of
  input or when its output is closed.
- **One shared fixture.** `experiments/issue-238-cgroup-polling.sh` recognises
  the stream by its `$0` (`start-command-cgroup-stream`), so the JS and Rust 238
  tests check the new call counts on the same fake `docker`. Its fake stream
  answers ticks from stdin. Its mocked `sleep` ends the ticker once the
  container stopped, or when the exec failed at once, as a real ticker would
  on its next write, so the counts stay deterministic.

## Call counts (shared fixture, four rounds)

From `ci-logs/issue-242/sampler-trace-before.txt` and `sampler-trace-after.txt`,
produced by `node experiments/issue-242-sampler-trace.js`:

| Mode | `docker exec` before → after | `{{.State.Running}}` before → after |
| --- | --- | --- |
| local cgroup readable, removed at the end | 1 → 0 | 1 → 1 |
| mounted socket, private namespace (the issue's case) | 4 → 1 | 4 → 1 |
| shared namespace (nothing can be sampled) | 0 → 0 | 4 → 0 |
| image without `sh` | 4 → 1 | 4 → 0 |
| daemon outage after the first sample | 4 → 4 | 4 → 4 |

In the issue's setup a run now costs one `docker exec` in total, not one per
round. Inside the container an interval costs no new process, down from about
seven. The outage row shows the fallback: the first stream breaks, a
second stream gets no sample, and per-round execs follow.

## Verification

- `js/test/regression-242.js` / `rust/tests/regression_242.rs`:
  - The stream script runs with an empty `PATH`, so any `cat`, `sed`, `cut` or
    `sleep` would fail, and newlines on stdin as ticks. Covered cases: one line
    per tick, no line before the first tick, exit 0 at end of input, `-` for a
    missing `memory.max`/`memory.peak`, and exit 3 on missing or malformed
    `memory.events`.
  - Full start/stop cycle against a fake mounted-socket daemon: one exec, no
    `{{.State.Running}}`, the sample in the post-mortem, no temporary files
    left, and the exec process gone after the sampler stops.
  - `off`, `OFF` and `Off`: no exec, no sleep, only the `HostConfig.Memory`
    lookup, and the "sampling disabled" reason.
  - The JS snippet is byte-identical to the Rust one through
    `parity/fixtures/cgroup-sampler-start-242.sh`.
- `js/test/regression-238.js` / `rust/tests/regression_238.rs` now assert the
  counts above. regression-182 and regression-192 pass unchanged.
- `ci-logs/issue-242/regression-242-before.txt`: all 13 JS tests fail on the
  original code.
- `ci-logs/issue-242/real-docker-after.txt`
  (`experiments/issue-242-real-docker.sh`, Docker 29.9.1, cgroup v2):
  - Setup: an `alpine` container with a private cgroup namespace, a fake cgroup
    bind-mounted at `/sys/fs/cgroup`, and the local cgroup hidden. The sampler
    is stopped while the task still runs.
  - While streaming, `ps` inside the container shows only the task and one
    `sh -c … start-command-cgroup-stream /sys/fs/cgroup`, with no `sleep`.
  - The sample shows the `oom_kill` bumped at four seconds, with its change
    time. No reason is written and no temporary files are left.
  - Two seconds after the stop, only the task is left in the container.
- `ci-logs/issue-242/real-docker-sleep-paced-stream.txt`: the same run with
  the first, sleep-paced design. Its loop and `sleep` are still in the
  container after the stop. The tick design exists because of this.

## Limitations

- If the stream itself breaks (a daemon restart, an exec killed from outside),
  the next round starts a new stream. Only a stream that delivers no sample
  switches to per-round execs. That is deliberate: a daemon outage should not
  cost the cheap path for the rest of the run.
- The host side still runs `date` and `mv` per recorded sample, as before, to
  keep the atomic sample file and the exit-time OOM timing. The ticker's
  `sleep` runs on the host and replaces the sampler loop's own `sleep` while
  the stream runs.
- After the sampler stops, the exec ends on the next tick, so it can outlive
  the sampler by up to one interval.
