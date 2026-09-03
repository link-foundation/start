# Case Study — Issue #165: the runtime said it ran out of memory and nobody read it

- Issue: https://github.com/link-foundation/start/issues/165
- Pull request: https://github.com/link-foundation/start/pull/167
- Downstream consumer: https://github.com/link-assistant/hive-mind/issues/2189
- Related prior work: #144, #148, #151, #162

## Result

Every memory signal `start` consulted was a *container* signal, and a runtime
that aborts on its own heap limit is invisible to all of them: it dies below the
container limit, so `docker inspect .State.OOMKilled` is genuinely `false` and
the cgroup `oom_kill` counter is genuinely `0`. Both readings are correct. Taken
together they produce a false negative for "out of memory" every single time a
Node process hits its own `--max-old-space-size` cap.

The evidence was never missing. The dying runtime prints
`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`
into the very log `start` already reads a tail of — 2 102 bytes from EOF in the
incident that produced this issue.

This PR reads it, in both implementations:

| Surface                                         | Change                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `--status` (all output formats)                 | `memoryExhausted true` plus `memoryExhaustedReason`, the log line that carried the proof.  |
| Text formatter                                  | `Memory Exhausted:  true` / `Memory Evidence:   <line>`, next to `OOM Killed:`.            |
| Log tail window                                 | 64 KiB for fatal markers (V8 prints a long native stack trace *after* the marker).         |
| Kept-container footer (detached watcher)        | For exit `134`/`139` with `oomKilled=false`, the reason now says the flag cannot see this. |
| Attached session's kept-container message       | Names the same evidence line instead of only "Container kept because the command failed."  |
| Marker table                                    | Adds the Go runtime OOM and `Array buffer allocation failed` markers from the issue.       |

The fields are observations, never verdicts. They are attached only when the run
ended abnormally (`exitCode` non-zero and not null), so a command that merely
*prints* a fatal marker — an `rg` dump, a quoted incident log — and then
succeeds is never reported as a memory failure. `status`, `exitCode` and
`oomKilled` are never changed, preserving the rule #148/#151 settled.

## Documents

| File              | Purpose                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `requirements.md` | Complete requirement inventory and disposition.                               |
| `timeline.md`     | Event sequence reconstructed from the incident and GitHub metadata.           |
| `root-cause.md`   | Why every consulted signal was blind, and why #162's `exitReason` was not enough. |
| `solutions.md`    | Alternatives considered, the selected design, and the verification plan.      |
| `data/`           | Issue, PR, diff and local verification evidence.                              |
| `ci-logs/`        | Branch workflow logs.                                                         |

## Evidence highlights

- `data/issue-165.json` records the reproduction verbatim: `exitCode 139`,
  `oomKilled=false`, and the kept-container footer asserting that flag eight
  lines below the runtime's own `FATAL ERROR`.
- The downstream classification the false negative produced was
  `cause=forced-kill — memory (10.3 GB of 11.7 GB RAM available)`: "killed for
  no reason on a machine with 10 GB free", for a process that had just told the
  log it ran out of memory. The wrong classification selected the wrong recovery
  policy.
- `data/js-focused-test.log` and `data/rust-focused-test.log` record the two
  regression suites driving the real CLI against a temporary `START_APP_FOLDER`,
  including the case where a 40 KiB synthetic native stack trace pushes the
  marker past the old 16 KiB window.
- `data/local-*.log` cover the full local gate set for both implementations.

No upstream defect was filed. Docker, the kernel and V8 all behave as
documented; the defect was this project reading only the signals that cannot
see a self-abort.
