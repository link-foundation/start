# Timeline

All timestamps are UTC. Incident times are quoted from issue #165 and its
downstream report; repository times come from the GitHub metadata in `data/`.

1. **Incident, 14:07:49** — A `solve` run under `--isolated docker` (image
   `konard/hive-mind-dind:2.15.1`, execution
   `0ea1c630-cfdf-477e-8528-29d175a7fe64`) dies with
   `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`.
   Node aborts itself at its own old-space cap, well below the container limit.
2. **Incident, same second** — `start` records `exitCode 139` and writes the
   kept-container footer `Reason: exitCode=139 oomKilled=false` — eight lines
   below the `FATAL ERROR` the runtime had just printed into the same file. Both
   halves of the footer are accurate readings of `docker inspect`; together they
   read as a denial.
3. **Incident, downstream** — link-assistant/hive-mind#2189 classifies the run
   from `exitCode` + `oomKilled` and reports
   `cause=forced-kill — memory (10.3 GB of 11.7 GB RAM available (12.2% used))`:
   a forced kill for no reason on a machine with 10 GB free. The wrong cause
   selects the wrong recovery policy.
4. **Downstream workaround** — Hive Mind re-derives the classification itself
   with a bounded 64 KiB tail read of the same log against its own pattern
   table, because `start` cannot supply the answer.
5. **2026-09-03 08:22:14** — Issue #165 is filed with a self-contained
   reproduction (`node --max-old-space-size=64` inside `--isolated docker`), a
   table of every signal that is structurally blind to a self-abort, and a
   four-part suggested fix.
6. **2026-09-03 10:10:40** — Draft PR #167 opens from branch
   `issue-165-1ffee76f3bb1`, based on `4efbc78`, which already carries the #162
   `exitReason` work and the #164 quoting fix.
7. **PR #167, JavaScript** — `exit-reason.js` gains marker-line extraction and
   `resolveMemoryExhaustion`; `readLogTail` moves into the leaf module
   `isolation-log-utils.js` so both the status formatter and the attached docker
   path can use it without a require cycle; `status-formatter.js` reads the tail
   once at 64 KiB and shares it with the footer scan, `attachExitReason` and the
   new `attachMemoryExhaustion`; `docker-cleanup.js` computes the kept reason in
   the shell; `regression-165.js` drives the CLI end to end.
8. **PR #167, Rust** — The same surface is ported: `find_exit_reason_marker` /
   `detect_memory_marker` / `resolve_memory_exhaustion`, the record fields, the
   formatter lines, the footer snippet and the attached message, plus the
   six-case `regression_165` suite and the shell-evaluated footer unit tests.
9. **PR #167, verification** — The full local gate set runs green for both
   implementations and is retained in `data/`.

Two derived facts are worth keeping. First, the marker in the incident sat
2 102 bytes from EOF, comfortably inside the *existing* 16 KiB window: the
window was widened for the tail V8 prints *after* the marker, not for the
incident itself, and the regression suites make that requirement explicit by
pushing the marker past 32 KiB. Second, the footer in step 2 is the string
downstream tooling greps, which is why fixing the reported fields without
fixing the footer would have left the visible contradiction in place.
