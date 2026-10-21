# One store decode and one `docker inspect` per status query

[Issue #243](https://github.com/link-foundation/start/issues/243) measured
`$ --status <uuid>` at about 1–1.4 CPU-seconds and `$ --list` at 17 s wall time
(15.8 CPU-seconds) on a host with 39 execution records, while the CLI starts in
about 0.2 s. The full issue is in `issue.json`.

## Root cause

Two costs grow with the number of records. Neither changes the output.

1. **The store was decoded on every read.** `get`, `getAll`, `getByStatus` and
   `getRecent` each called `readLinoRecords()` / `read_lino_records()`, which
   read and decoded the whole `executions.lino`. One `--status` decoded it up
   to three times: `get`, then `getAll` twice in `execution-chain`
   (`attachIdentity` and `buildChain`). `experiments/issue-243-decode-cost.js`
   measures `lino-objects-codec` at about 1.24 ms per record on this host,
   flat from 39 to 200 records. The issue measured about 4 ms per record on
   its host. `JSON.parse` of the same records costs 0.005 ms per record.
2. **Every docker record got its own `docker inspect` processes, one after
   another.** `listExecutions` sent every record through
   `prepareRecordForList`:
   - `enrichDetachedStatus` → `readDockerState` (`{{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}} …`);
   - `persistContainerRemoval` → `dockerObjectMissing` (`{{.Id}}`);
   - `attachProcessIds` → `collectProcessIds` (`{{.Id}} {{.State.Pid}}`).

   This ran whatever the stored status was. It ran even for records whose
   container `$` had already recorded as removed (#225), which can never
   answer again.

## What changed (JavaScript first, Rust in parity)

| Requirement from the issue | Implementation |
| --- | --- |
| 1. Decode the store once per process | `store-decode-cache.js` / `store_decode_cache.rs`: a process-wide map from the store path to `{content, decoded records}`. The file is still read on every call, so a write by any process is seen at once. It is decoded again only when its content differs from the decoded copy. Every read gets its own deep copy (`structuredClone` / `clone`), so callers that change records cannot corrupt the cache. `get`, `getAll`, `getByStatus`, `getRecent` and the execution chain all share it. |
| 2. Probe only records whose answer can change | `readDockerState` / `read_docker_state` and the docker branch of `collectProcessIds` / `collect_process_ids` return before any probe when the record's `containerState` is `removed`. `dockerProbeTargets` / `docker_probe_targets` leaves those records out of the batch. Terminal records that still name a kept container are still probed, as #225 needs. Executing records keep their liveness check. |
| 3. Batch the Docker probes | `docker-inspect-batch.js` / `docker_inspect_batch.rs`: `--list` and `--status` run inside `withDockerInspectBatch` / `with_docker_inspect_batch`. That runs one `docker inspect --type container -f '{{.Name}} {{.Id}} {{.State.Pid}} {{.State.Running}} {{.State.ExitCode}} {{.State.OOMKilled}} {{.State.StartedAt}} {{.State.FinishedAt}}' <every session name and container ID>`. The per-record probes (`dockerInspect`, the process-ID probe, the removal check) first ask `prefetchedInspect` / `prefetched_inspect`, which renders their own `-f` template from the batch. |
| 4. Optional: a faster decode path | The decoded records are also written as JSON next to the store (`executions.decoded.js.json` / `executions.decoded.rust.json`), tagged with a format string and the SHA-256 of the `.lino` content they came from. A new process whose store content has the same digest parses that JSON instead of decoding (about 250× cheaper). A copy whose digest or format does not match, or that does not parse, is ignored, and the store is decoded and the copy replaced. |
| Output must not change | The regression tests run the same store through the per-record path and the batched path and compare the full JSON output. |

Details:

- **Matching batch lines to targets.** Docker prints one line per found
  container in argument order, plus one `No such container: <target>` line on
  stderr for each missing one. Each line is matched back by name (`/<name>`)
  or ID prefix, so the result does not depend on line order. Docker's own
  "no such container" for a target wins over an ID-prefix match with another
  container. `--type container` keeps an image or volume with the same name
  from answering.
- **Anything the batch cannot answer runs as before.** That covers an unknown
  template field, a target that is neither in the output nor reported missing,
  an old or stubbed `docker` that rejects `--type`, and a daemon error. In
  each case `prefetchedInspect` returns nothing and the original
  `docker inspect -f <format> <target>` runs. A missing target gets the
  original failure (`exit 1`, `Error response from daemon: No such container: …`),
  so `dockerObjectMissing` and `readDockerState` keep their meaning.
- **Scope of a batch.** The answers live only while one query runs (a
  module-level value in JS, a `thread_local` with a drop guard in Rust).
  Outside a query, `prefetchedInspect` always returns nothing, so `--stop`,
  `--resume` and the watcher still read live state. Nested queries reuse the
  outer batch.
- **Why the content is the key, not `(mtime, size, ino)`.** The issue suggested
  stat keys. A coarse mtime cannot tell two same-size writes apart within one
  clock tick. In-process, comparing the content string the store already read
  costs microseconds. Across processes, its SHA-256 costs 0.11 ms for 39
  records. Neither can go stale.
- **Why the cache is not filled on write.** `decode(encode(records))` is not
  guaranteed to equal `records` (lino may normalise values). The write path
  therefore leaves the next read to decode. A process that writes and then
  reads pays one decode, as before.
- **When the JSON copy is not written.** JS writes it only when
  `JSON.parse(JSON.stringify(records))` deep-equals the decoded records. A
  value JSON cannot represent exactly (`Date`, `undefined`, `NaN`) means no
  copy and a decode next time. Rust already converts decoded lino values to
  `serde_json::Value` before building records, so its copy holds exactly
  those values. The two editions use separate files because their decoded
  shapes are not promised to be identical. The copy is written with
  `atomicWrite` / `atomic_write`, on a best-effort basis: a read-only folder
  only costs a decode.

## Scope notes

- `--resume-all` still probes records one by one. Each resume needs live state
  just before it acts, and the issue's batching requirement covers `--list` and
  `--status`.
- Screen and tmux records keep their per-record `screen -ls` / `tmux has-session`
  probes. The issue's measurements and batching requirement are about Docker,
  and one `screen -ls` per record is a local socket check, not a daemon round
  trip.
- `--list --running` uses the same batched path as `--list`.

## Evidence

- `experiments/issue-243-decode-cost.js`: lino decode vs `JSON.parse` vs
  SHA-256 per record (numbers above).
- `experiments/issue-243-real-docker.js`, against Docker 29.9.1 with a
  39-record store shaped like the issue's. The store has 2 running task
  containers, 6 kept exited containers, 14 finished records whose containers
  are gone, 12 already marked removed and 5 non-docker records. The before
  tree is the branch before this change. Results:
  `ci-logs/issue-243/real-docker.txt`.

  | Command | Before: wall (3 runs) | Before: `docker` calls | After: wall (3 runs) | After: `docker` calls | Same output |
  | --- | --- | --- | --- | --- | --- |
  | `--list` | 20.99 / 20.13 / 17.32 s | 88 inspect | 1.16 / 0.47 / 0.40 s | 1 inspect | yes |
  | `--status` (kept container) | 0.81 / 0.66 / 0.49 s | 3 inspect | 0.47 / 0.52 / 0.39 s | 1 inspect | yes |
  | `--status` (running) | 0.83 / 1.64 / 1.84 s | 2 inspect | 0.45 / 0.40 / 0.81 s | 1 inspect | yes |

  With the JSON copy already present, `--status` took 0.46 / 0.46 / 0.71 s.
  At 39 records the CLI start-up dominates, so the copy pays off more on
  larger stores and slower hosts (the issue's 4 ms per record).

- `js/test/regression-243.js` / `rust/tests/regression_243.rs`:
  - `--list` and `--status` against a fake docker that logs every call: one
    `inspect` per query instead of many, with output identical to the
    per-record path (a legacy fake that rejects `--type`);
  - a container marked removed is never named in any docker call;
  - a removal the batch observed is still persisted;
  - name or ID-prefix matching, not-found priority, and unanswerable targets
    falling back to their own probe;
  - batch answers only inside a query;
  - one decode for `--status` + `getAll` + `get`, independent copies, and
    writes by another store object seen at once;
  - the next process reads the JSON copy without decoding, and decodes again
    when the copy is stale or damaged;
  - no copy for records JSON cannot represent.
