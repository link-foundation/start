# Issue 209: missed exit-time OOM evidence

An exit-137 task can now use a recent Docker `oom` event for its exact container
when the final cgroup sample misses the fatal kill. The sticky `OOMKilled` flag
alone remains insufficient. Archived attempts use their own persisted evidence
and bounded log ranges, including while the current attempt is running.

## Evidence and provenance

- [Original issue and embedded incident excerpts](data/issue-209.json), downloaded
  on 2026-10-12. There were no comments or downloadable attachments.
- [Issue comments](data/issue-comments.json), [initial PR](data/pr-210-before.json),
  [inline comments](data/pr-review-comments.json), [conversation](data/pr-conversation.json)
  and [reviews](data/pr-reviews.json) preserve all available discussion.
- [Sticky flag safeguard](data/issue-178.json), [ordinary exit safeguard](data/issue-180.json),
  [scope caveat](data/issue-185.json), [daemon restart incident](data/issue-194.json),
  [memory recovery requirements](data/issue-191.json) and
  [downstream report](data/hive-mind-2892.json) establish the surrounding contracts.
- [Downstream comments](data/downstream-comments-before-followup.json) and
  [the follow-up report](data/downstream-followup.md) preserve integration guidance
  sent to the existing issue, including reproduction, workaround and code policy.
- [Moby flag change](data/moby-43564.json), [its discussion](data/moby-43564-comments.json)
  and [daemon event implementation](data/moby-monitor.go) preserve upstream evidence.
  The daemon source revision is recorded in [moby-source-sha.txt](data/moby-source-sha.txt).
- [Docker event documentation](data/docker-events.html) and
  [kernel cgroup documentation](data/cgroup-v2.html) are downloaded source snapshots.
- [Linux PID namespace documentation](data/linux-pid-namespaces.html) explains
  the external-kill probe correction described below.
- [Before-fix regressions](data/regressions-before.txt) show five failures, including
  the stale-sample event and historical-status cases. Passing focused checks are
  retained in `data/`; final CI logs are retained under repository `ci-logs/`.

The original complete task log, Docker event stream and host journal were not
attached to the issue. The incident excerpts are reported evidence, not a new
host measurement. The reproducing tests supply explicit event timestamps to
demonstrate the missing collection path independently of the original host.

## Incident timeline

The issue gives UTC times but no incident date; do not infer a calendar date.

| Time UTC       | Observation                                                          | Consequence                                                                  |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 09:23:24       | Kernel kills child `claude`, PID 2369363                             | Sticky flag becomes true; last sampled `oom_kill` becomes 1                  |
| After 09:23:24 | Last retained sample reports limit 3135369216, peak 3135373312 bytes | Peak exceeded the limit by 4096 bytes, but provides no exit-time attribution |
| 09:24:01       | Kernel kills main `node-MainThread`, PID 2350797                     | Fatal second kill occurs after the retained sample                           |
| 09:24:02.592   | Docker reports exit 137                                              | Child sample is approximately 38.6 seconds old                               |
| Finalization   | Cgroup is gone; local journal cannot establish host facts in DooD    | `mainOom` remains false and reason becomes unknown SIGKILL                   |
| Status query   | Only current record is enriched                                      | Earlier attempts retain incomplete or stale diagnostics                      |

Issue 209 was opened on 2026-10-11 at 16:45:18 UTC. PR 210's prepared commit was
created on 2026-10-12 at 13:07:36 UTC. Its original JavaScript and Security runs
completed successfully before any solution push.

## Requirements and implementation plan

| Requirement                                       | Implementation and evidence                                                                                                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explain fatal OOM after the final sample          | Query Docker's bounded event history for the inspected full container ID and correlate with exit 137; JavaScript and Rust issue-209 regressions                                                                       |
| Work inside DooD without the host journal         | Event query uses the configured Docker CLI/socket; mock test verifies remote `DOCKER_HOST` skips local journal only                                                                                                   |
| Avoid sticky child-OOM false positives            | Event attribution requires exit 137 and a timestamp near completion; ordinary exits, historical events and malformed events are rejected                                                                              |
| Preserve daemon restart diagnosis                 | Matching local Docker service force-kill evidence takes precedence over both events and sampled deltas                                                                                                                |
| Report `memoryExhausted` along with the reason    | Both resolvers recognize event-derived main evidence, even without a sticky flag or surviving counters                                                                                                                |
| Recompute earlier attempts                        | Archive `exitEvidence`; independently enrich history from stored facts or its own byte range without mutating the input                                                                                               |
| Recover with a larger configured memory limit     | Recovery accepts attributed main evidence from the attempt log, rather than requiring another sampled delta; issue-191 regressions cover ordering and persistence                                                     |
| Test child OOM then main OOM 30 seconds later     | Finite three-scenario Docker probe on the Linux JavaScript CI runner; deterministic unit test uses the incident's older sample                                                                                        |
| Test child OOM then normal exit 1                 | Unit safeguards plus finite Docker probe; external SIGKILL after the earlier child OOM is a third control                                                                                                             |
| Archive data and perform deep analysis            | This case study includes raw discussion, incident excerpts, source snapshots, timeline, alternatives and validation logs                                                                                              |
| Search for external facts and reusable components | Authoritative Docker, kernel and Moby sources below; reuse existing CLI runner instead of introducing a second Docker client                                                                                          |
| Add diagnostic output for missing evidence        | `START_DEBUG=1` records the container ID, finish time, event query availability/results and last sample; watcher captures stderr only in debug mode                                                                   |
| Report problems in related projects               | No new engine defect was established; Moby PR 43564 documents the flag behavior. A follow-up report with reproduction, workaround and code guidance was posted to existing Hive Mind issue 2892, avoiding a duplicate |
| Apply across the codebase and preserve parity     | Shared collector serves attached and detached paths; finalizer recognizes the new log marker; recovery and historical status are updated in both languages, with shared golden contracts and feature inventory        |
| Prepare a release and complete one PR             | JavaScript changeset and Rust changelog fragment; PR 210, regular commits, JavaScript-gated Rust CI, clean final worktree and current-main ancestry                                                                   |

## Root causes and chosen solution

The counter sampler is a lossy observer. It cannot read a cgroup after the main
process exits and the runtime removes that cgroup. Increasing the three-second
window would still rely on the earlier child's counter change and misattribute
later unrelated SIGKILLs. Increasing sampling frequency also leaves a race.

The collector previously had two sources: local `journalctl` for Docker daemon
restart evidence, and a timestamped cgroup delta. Neither supplies the missing
fatal event in the described DooD environment. It now inspects the full container
ID, checks a matching local daemon-restart journal when available, then queries:

```text
docker events --since <FinishedAt-60s> --until <FinishedAt+1s>
  --filter container=<full-id> --filter event=oom --format '{{.Time}}'
```

Only a valid positive integer event time between three seconds before completion
and one second after completion qualifies, and only for exit 137. The same
daemon supplies `FinishedAt` and event timestamps, avoiding client-clock offsets.
No events, unavailable Docker, malformed timestamps or stale events preserve the
unknown reason unless the existing fresh-sample path qualifies. The event query
has an explicit end time and is not an indefinite subscription.

Status enrichment only processed the current record. Further, attempt archival
omitted `options.exitEvidence`, which resume subsequently cleared. The fix copies
evidence into each snapshot. Historical log reads are capped at 64 KiB and end
at the next known attempt offset. Missing or invalid boundaries prohibit log
inference. Current options and current fatal output never become old-attempt
evidence. Both implementations retain raw exit codes, flags and counters.

Recovery independently repeated the sample-delta condition. It now consumes
the same main-OOM log marker and preserves that evidence before archiving and
resetting the current attempt, so memory escalation works for the missed sample.

## Research, alternatives and limits

Docker supports container/event filters, timestamp bounds and formatted event
output, but returns only its last 256 historical events. Querying promptly in the
watcher is therefore preferable to querying years-old records during status.
The existing CLI connection also works for a remote daemon. [Docker documentation](https://docs.docker.com/reference/cli/docker/system/events/)

The kernel defines `oom_kill` as processes killed by OOM killers and `oom` as
allocation-related events; the counts have different units. `memory.peak` is
historical usage. None independently identifies which process caused a later
exit. [Kernel documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory-interface-files)

Moby sets `State.OOMKilled` and emits a container `oom` event on its runtime OOM
notification, rather than only when PID 1 dies. The new attribution is temporal
correlation with SIGKILL, not a PID-level proof; an unrelated kill coincident
with a child OOM within that window remains ambiguous. [Moby daemon source](https://github.com/moby/moby/blob/829b72acfe767b0e3243756b3c944195a06b8c38/daemon/monitor.go),
[sticky flag change](https://github.com/moby/moby/pull/43564)

Alternatives considered:

1. `exit 137 + OOMKilled + peak >= limit` would repair historical records without
   retained events, but could also blame an old child OOM for a daemon restart
   or external kill. It is deliberately omitted to preserve issues 178/194.
2. A long-lived event subscriber could protect against Docker's history eviction,
   but adds monitor lifecycle and persistence work. The prompt exit-time query
   reuses the existing collector and leaves no additional daemon running.
3. Host journal/eBPF attribution can identify victim PIDs, but needs privileged
   host access unavailable in the reported deployment.
4. Dockerode or the Engine API can expose the same stream, but would duplicate
   existing Docker CLI transport/authentication and add a dependency without
   recovering extra evidence. Its documented socket/HTTP transports were checked
   against the existing CLI adapter. [Dockerode documentation](https://github.com/apocas/dockerode)
   is preserved in [the source snapshot](data/dockerode-readme.txt).

Older records without stored attribution or a bounded surviving evidence log
remain unknown. The fix cannot reconstruct discarded events from a peak value.
Remote daemon restart evidence still requires additional host visibility.

## Reproduction and validation

Local `cd js && bun run check && bun run test` passes: 1239 tests, zero failures.
The initial full run found one workflow invariant violation (`always()` outside
the status job); the artifact step was corrected to `!cancelled()` and the full
suite rerun. Both raw runs are preserved. Feature inventory, shared contracts,
JavaScript-first workflow gating, generated-code verification and Rust formatting
also pass. The gated CI runner subsequently passed Rust compilation/tests on
Linux, macOS and Windows and the real Docker probe documented below.

Run `bun test ./js/test/regression-209.js ./js/test/regression-191.js ./js/test/shared-golden.js`
for deterministic behavior. Matching Rust targets run through the existing CI
stage after the complete JavaScript stage succeeds. Supported generated policy
code was regenerated and checked; no native adapter was represented as
translated executable code.

Run `node experiments/issue-209-docker.mjs` on a Linux Docker host to execute
the real probe. Each scenario creates one container limited to 128 MiB memory
and swap, 32 PIDs and half a CPU. The worker validates its cgroup limit before
allocating, uses finite allocations, and sets a 70-second alarm. It kills a
child first, saves that sample, waits 30 seconds, then exercises main OOM,
normal exit 1 or an independent SIGKILL. Containers are removed after each
scenario. Raw state, sample, commands/events and resolved diagnostics are JSONL.

This workspace's Docker 29.9.0 cannot start the limited probe: runc reports
`cannot enter cgroupv2 ... with domain controllers -- it is in an invalid state`.
[Raw local failure](data/docker-probe-stderr.txt) and [daemon information](data/docker-info.txt)
are retained. No allocations ran and no host configuration was changed. The
Linux JavaScript test job runs the probe and preserves its raw output as a
downloadable artifact, before Rust can proceed.

### First CI run and correction

Run [38256483100](https://github.com/link-foundation/start/actions/runs/38256483100)
tested commit `cf68c5cd174742f55addf0d3c31a0ca4d452b9e9` after its push.
All JavaScript test suites, coverage, lint, translation and workflow checks passed.
The Linux suite ran 1242 tests with zero failures (raw log lines 11840–11842).
The real Docker probe was the only failing step; the aggregate JavaScript stage
failed as required, and Rust did not run. Security and link workflows passed.
The [complete raw log](../../../ci-logs/javascript-38256483100.log) and
[probe artifact](data/ci-docker-probe-first/docker-probe.jsonl) preserve the evidence.

The fatal-OOM scenario succeeded: the child event at `1791812130` and main event
at `1791812161` were 31 seconds apart. Docker finished at
`2026-10-12T13:36:01.036895222Z`, while the retained cgroup sample still had
`oom_kill=1` at the child's timestamp. The new collector selected the final event
and reported memory exhaustion. The ordinary exit-1 scenario also succeeded,
preserving no memory diagnosis despite the sticky flag.

The external-kill control attempted `os.kill(1, SIGKILL)` from namespace PID 1.
That signal was ignored, and the worker fell through to exit 1; the assertion
correctly rejected it ([stderr](data/ci-docker-probe-first/docker-probe-stderr.txt)).
Linux documents special signal rules for namespace init, with SIGKILL forcibly
delivered from an ancestor namespace. [Linux man-pages](https://www.man7.org/linux/man-pages/man7/pid_namespaces.7.html)
The correction sends `docker kill --signal=KILL` after 32 seconds instead,
keeping the earlier child OOM outside the attribution window. The worker waits
for that kill with the original 70-second alarm; no timeout was increased.

Run [38257408096](https://github.com/link-foundation/start/actions/runs/38257408096)
tested correction commit `42cccf0cf827515bfd9d3c62f1c61cb51afa19e1` after all
earlier runs completed. The [corrected Docker artifact](data/ci-docker-probe-corrected/docker-probe.jsonl)
passes all three scenarios:

| Scenario                             | Exit | Sticky flag | Event evidence                                | Resolved diagnosis                          |
| ------------------------------------ | ---- | ----------- | --------------------------------------------- | ------------------------------------------- |
| Child OOM, then main OOM             | 137  | true        | `1791812585`, `1791812615` (30 seconds apart) | cgroup OOM; `memoryExhausted=true`          |
| Child OOM, then normal exit          | 1    | true        | No event query needed                         | No OOM diagnosis                            |
| Child OOM, then external Docker kill | 137  | true        | Only old event `1791812647`                   | SIGKILL, cause unknown; no memory diagnosis |

The complete JavaScript stage succeeded before Rust began. The downstream
[follow-up report](https://github.com/link-assistant/hive-mind/issues/2892#issuecomment-6125541863)
explains this distinction and recommends consuming attributed diagnostics for
each attempt instead of treating the sticky flag as a fatal-OOM verdict.

All checks on that implementation commit passed, including JavaScript and Rust
tests on all three platforms, both coverage jobs, shared parity contracts,
translation, Rust audit, CodeQL, dependency review, secrets scan, workflow checks
and link checks. [Run timestamps and SHAs](data/ci-validated-runs.json),
[job results](data/ci-validated-jobs.json) and [check list](data/ci-validated-checks.txt)
record the completed validation. Complete unmodified logs are archived with gzip:
[JavaScript and gated Rust](../../../ci-logs/javascript-38257408096.log.gz),
[Security](../../../ci-logs/security-38257407825.log.gz),
[Workflows](../../../ci-logs/workflows-38257407823.log.gz) and
[Links](../../../ci-logs/links-38257407812.log.gz). Use `gzip -dc` to inspect them.
The final review also checked nullable stored evidence. JavaScript treats
`exitEvidence: null` as absent and uses the surviving log; a stored object with
both findings false intentionally takes precedence over that log. The Rust
adapter now preserves this distinction, with corresponding finalization/status
regressions in both languages. The final commit receives the full CI checks
before PR readiness.
