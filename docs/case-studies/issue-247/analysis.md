# Stop the cgroup sampler when the counters are unreadable

[Issue #247](https://github.com/link-foundation/start/issues/247) reports that
in 0.39.0 the detached Docker cgroup sampler runs for the whole life of the
task on hosts where no round can produce a sample. These are hosts where the
local cgroup cannot be read and the container has no `memory.events`, because
the `memory` controller is not delegated. Each interval costs one
`docker exec` and one `docker inspect -f {{.State.Running}}`. The JSDoc of
`buildCgroupSamplerStartSnippet` said the sampler "records the reason and
stops" in that case. The full issue is in `issue.json`.

## Root cause

The sampler had two ways to read the container's cgroup, and neither told
"unreadable counters" apart from a transient failure:

1. The long-lived stream (#242) exits 3 on unreadable counters. The sampler
   handled only `0` and `126|127`, so exit 3 set `__scs_stream=0` and moved on
   to per-round execs.
2. The per-round read ran `__start_command_cgroup_read /sys/fs/cgroup`, which
   returns 1 on unreadable counters. The client gets the same status for a
   daemon error, and a failed per-round read never broke the loop. It wrote
   the reason, asked Docker for `{{.State.Running}}` and slept for one interval.

So on such a host the loop repeated "exec, inspect, sleep" until the container
stopped. The last round then overwrote the useful reason with
`container … is not running`, which is what the post-mortem printed.

## What changed (JavaScript first, Rust byte-identical)

| Requirement from the issue | Implementation |
| --- | --- |
| Stream exit 3 records the reason and stops | `case "$__scs_exit" in 0) …;; 3\|126\|127) break;; *) __scs_stream=0;; esac` |
| A per-round read failing the same way records the reason and stops | The in-container command is now `__start_command_cgroup_read /sys/fs/cgroup \|\| exit 3`. After writing the reason, `case "$__scs_exit" in 3\|126\|127) break;; esac` stops the loop. Exit 126/127 from a per-round exec now stops too, as the JSDoc already said. |
| The JSDoc matches the code | The JSDoc of `buildCgroupSamplerStartSnippet` / `build_cgroup_sampler_start_snippet` and `buildCgroupStreamScript` names exit 3 and the backoff. `CGROUP_UNREADABLE_EXIT = 3` is shared by both reads. |
| Transient failures may be retried, with backoff | Every round without a sample doubles the wait. The cap is `CGROUP_SAMPLE_BACKOFF_MAX_SECONDS = 60`, but the wait is never shorter than the interval. Any sample (local, streamed or per-round) restores the interval. With the 5 s default a daemon outage costs 5, 10, 20, 40, 60, 60… s between rounds instead of 5 s. |
| `docker wait` still finishes the run | Unchanged: the stop snippet and the completion watcher do not depend on the sampler loop. |

The reason file now keeps the real cause:
`Memory: unavailable (local cgroup unavailable; Docker exec exit=3: private cgroup v2 counters unreadable)`.

## Measurements

Real daemon (`experiments/issue-247-real-docker.sh`, Docker 29.9.1, cgroupfs,
cgroup v2, root `cgroup.subtree_control` without `memory`, one
`--isolated docker --detached --image alpine:3.20 -- sleep 20` task, 1 s
interval). Logs: `ci-logs/issue-247/real-docker-before.txt`,
`ci-logs/issue-247/real-docker-after.txt`.

| | `docker exec -i` | `docker exec` (all) | `{{.State.Running}}` | all `docker` calls |
| --- | --- | --- | --- | --- |
| 0.39.0 | 1 | 16 | 19 | 51 |
| this change | 1 | 1 | 3 | 20 |

The three remaining `{{.State.Running}}` matches come from the rest of the
detached run (the completion watcher and the post-mortem inspect), not from
the sampler. With the fix the sampler starts one
stream exec, gets exit 3, writes the reason and exits.

Shared fixture (`experiments/issue-238-cgroup-polling.sh`, four rounds,
`ci-logs/issue-247/sampler-trace-before.txt` / `sampler-trace-after.txt`):

| Mode | `docker exec` before → after | `{{.State.Running}}` before → after | sleeps before → after |
| --- | --- | --- | --- |
| no `memory.events` (the issue's case) | 4 → 1 | 4 → 0 | 5,5,5 → none |
| no `memory.events`, first stream breaks | 4 → 2 | 4 → 1 | 5,5,5 → 10 |
| daemon outage after the first sample | 4 → 4 | 4 → 4 | 5,5,5 → 5,10,20 |

## Verification

- `js/test/regression-247.js` / `rust/tests/regression_247.rs` run the real
  in-container scripts against a fixture cgroup directory without
  `memory.events`. They check:
  - one stream exec and nothing after it on exit 3;
  - a per-round exit 3 stops after one round;
  - a per-round exit 127 stops after one round;
  - the backoff sequence, the 60 s cap, a longer interval as the floor, and
    an unchanged interval while samples arrive.
- `ci-logs/issue-247/regression-247-before.txt`: 6 of the 8 JS tests fail on
  the 0.39.0 code. The two that pass check that a working sampler keeps its
  interval and that a longer interval is never shortened.
- regression-182, -192, -238 and -242 pass unchanged. The golden snippet
  `parity/fixtures/cgroup-sampler-start-242.sh` was regenerated, so JS and Rust
  still produce byte-identical shell.

## Limitations

- Stopping on exit 3 is permanent for the run. If the `memory` controller is
  delegated while a task runs, that task is not sampled any more. Controller
  delegation happens at container creation in practice, so no later round
  could change the answer.
- A daemon outage that never ends still costs one exec and one inspect per
  minute until the container stops. That keeps samples coming after a daemon
  restart, which a hard N-failure limit would give up.
