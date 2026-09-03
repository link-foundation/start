# Solutions

## Alternatives considered

### A. Rewrite `oomKilled` to `true` when the log shows a fatal marker

Rejected. `oomKilled` is a reading of `docker inspect .State.OOMKilled`, and
that reading is correct: the kernel really did not kill anything. #148/#151
settled that the flag is an observation, never a verdict; overwriting it would
make the field mean two different things depending on how the process died, and
would break every consumer that treats it as the cgroup fact it is.

### B. Map exit codes `134`/`139` to "out of memory"

Rejected. Those codes are SIGABRT and SIGSEGV. A genuine segfault, an assertion
failure and a heap-limit abort are indistinguishable by code alone, so this
trades a false negative for a false positive.

### C. Report only the existing `exitReason` category, more prominently

Rejected as insufficient. It leaves the consumer mapping a taxonomy string back
to a yes/no question, never surfaces the line that proves it, and does nothing
about the footer that asserts the opposite.

### D. Re-derive the classification downstream

This is the current workaround in link-assistant/hive-mind#2189, and it is the
reason the issue was filed. Every consumer would need its own pattern table and
its own bounded tail read of a log `start` owns, and each would drift
separately. `start` already reads that tail.

## Selected design

**Read the evidence once, report it as an observation, and stop contradicting
it.**

1. **One tail, wider window.** `FATAL_MARKER_TAIL_BYTES = 64 * 1024`.
   `enrichDetachedStatus` / `enrich_detached_status` read the tail once at that
   width and pass it to the footer scan, `exitReason` and the new memory
   observation. Widening is safe for the footer because its matcher is anchored
   to the three-line block (issue #150), so a wider window cannot make it match
   something new.

2. **The line, not just the category.** `findExitReasonMarker` /
   `find_exit_reason_marker` return both the marker's category and the whole
   line that carried it, trimmed and bounded to 300 characters so a runtime that
   prints a single enormous line cannot flood `--status` output.
   `detectExitReason` is now a thin projection of that function, so the two
   paths can never disagree about what matched.

3. **An observation, never a verdict.** `resolveMemoryExhaustion` returns
   nothing unless the exit code is a finite non-zero number. `oomKilled === true`
   is accepted as evidence in its own right, with
   `"Docker reported State.OOMKilled=true"` as the reason, so the two mechanisms
   answer the same question in the same field.

4. **A footer that cannot contradict the log.** The detached watcher now
   computes `$__start_command_reason` in the shell before printing it. For an
   exit code in `{134, 139}` with `oomKilled` not `true`, it appends
   `(a runtime self-abort on its own memory limit is invisible to this flag - …)`.
   A single `printf` still emits the block, and the plain
   `exitCode=N oomKilled=B` form is untouched for every other code — including a
   real `137`/`true` OOM kill.

5. **Attached sessions.** `--status` covers them already, because
   `enrichDetachedStatus` runs for every record `queryStatus` and `--list`
   return, and the regression suites assert that for an
   `isolationMode: attached` record. The attached kept-container *message* also
   names the evidence line, so the operator watching the terminal sees what the
   `--status` reader sees.

### Implementation notes

- `readLogTail` moved from `status-formatter.js` into the leaf module
  `isolation-log-utils.js`. `isolation.js` needs it, and
  `isolation.js → status-formatter.js → docker-cleanup.js` would have closed a
  require cycle. `status-formatter.js` re-exports it, so its public surface is
  unchanged.
- The attached kept-container message moved out of `isolation.js` into
  `buildAttachedDockerKeptMessage` in `docker-cleanup.js`, which is where the
  detached equivalent already lives — and which keeps `isolation.js` under the
  1000-line limit.
- The attached path reads the tail inside `child.on('exit')`, which can fire
  before the last buffered output is flushed. That read is therefore best-effort
  and documented as such; `--status`, which reads the log later, is the
  authoritative surface. Switching the handler to `'close'` would risk hanging
  when a grandchild holds the pipes open, which is a worse trade.
- The marker table gained the two runtimes from the issue's suggested pattern
  list that were not yet covered: `fatal error: runtime: out of memory` (Go) and
  `Array buffer allocation failed`.

## Verification plan

| Check                        | Command                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| JavaScript regression suite  | `cd js && bun ../scripts/run-js-tests.mjs ./test/regression-165.js` |
| JavaScript unit suite        | `cd js && bun ../scripts/run-js-tests.mjs ./test/exit-reason.js`    |
| Full JavaScript suite        | `cd js && bun run test`                                    |
| Rust regression suite        | `cd rust && cargo test --test regression_165`              |
| Full Rust suite              | `cd rust && cargo test`                                    |
| Lint / format / file size    | `cd js && bun run check`                                   |
| Clippy / fmt                 | `cd rust && cargo clippy --all-targets -- -D warnings && cargo fmt --check` |

The regression suites deliberately assert three things a narrower fix would
pass: that the marker is still found when a 40 KiB stack trace pushes it past
the old window, that a successful run which merely prints the marker reports
nothing, and that the generated footer snippet — evaluated in a real `sh` for
`134`, `139`, `1` and `137` — stops asserting a bare `oomKilled=false` only for
the self-abort codes.
