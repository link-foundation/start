# Issue 207 requirement map and implementation plan

Scope: [207](https://github.com/link-foundation/start/issues/207),
[205](https://github.com/link-foundation/start/issues/205), and
[206](https://github.com/link-foundation/start/issues/206). All descriptions and
paginated comments were read on 2026-10-11; none had comments. Related work:
issues 189 and 193, merged PRs 196 and 204, and Hive Mind issue 2801.

| Requirement                                                           | Alternatives                                                    | Selected plan and evidence                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 207.1 Read and implement both child issues, including comments        | Separate fixes; one combined change                             | One PR, with JavaScript behavior first and matching native evidence.                                                                                           |
| 207.2 Complete everything in PR 208                                   | Defer monitor recovery                                          | Implement base discovery and recovery together because recovery needs the remembered base.                                                                     |
| 207.3 Close parent and both children                                  | Grouped reference (insufficient)                                | Separate `Fixes #205`, `Fixes #206`, `Fixes #207` lines in the description.                                                                                    |
| 207.4 Explicitly identify already resolved/nonreproducible issues     | Assume previous fixes suffice                                   | Both bugs are present in current source; add failing regressions before fixes.                                                                                 |
| 205.1 Discover limits applied after launch or changed later           | One delayed inspect; periodic inspect; Docker API stream        | Read HostConfig on every tick using the existing Docker CLI adapter.                                                                                           |
| 205.2 Trigger at 95% of min(base, daemon NCPU)                        | Launch flags only; observed base                                | Update base while observing, reset coverage when it changes, retain daemon resize handling.                                                                    |
| 205.3 Lift to the remembered base N, not NCPU                         | Remove quota; explicit finite restoration                       | Restore min(base, current NCPU) through the current NanoCPU or legacy quota representation. Never use `--cpus 0`.                                              |
| 205.4 Keep the pre-penalty base while capped                          | Read every current cap as a base (incorrect); phase-aware reads | Ignore the monitor's own cap. A different external quota ends that penalty and establishes a new base.                                                         |
| 205.5 Persist base for status and monitor restart                     | Rewrite execution store every tick; sidecar                     | Keep the existing attempt-scoped sidecar and preserve its saved base on restart.                                                                               |
| 205.6 Regression verifies trigger, restoration, status                | Pure policy test only; adapter test                             | Shared finite fake-Docker fixture verifies actual update arguments and persisted/status state in both runtimes.                                                |
| 205.7 Transition lines name window and correct denominator            | Existing ambiguous lines; transition formatter                  | Apply uses usable capacity; lift uses penalty capacity; both include the relevant duration.                                                                    |
| 206.1 Restart a monitor that dies while its watcher lives             | Poll `kill -0`; supervisor waits/reaps its child                | Watcher-owned shell supervisor restarts and reaps monitors, including attached/untracked paths.                                                                |
| 206.2 Recover after monitor and watcher die through resume/resume-all | Restore immediately; restart and cover fresh quiet window       | Existing watcher reattachment launches the same supervisor; stale lock reclamation permits replacement.                                                        |
| 206.3 Reclaim zombie owner locks                                      | PID signal only; proc state                                     | Linux proc state Z/X means dead, even when signal zero succeeds.                                                                                               |
| 206.4 Reclaim locks held by reused PIDs                               | Command-line check; process birth identity                      | Save Linux process start time in all new locks; CPU locks also validate legacy owners' monitor command marker.                                                 |
| 206.5 One tick exception must not terminate monitoring                | Outer catch exits; per-tick catch                               | Catch inspect/stats/update/publication failures, clear window coverage, trace under START_DEBUG, retry.                                                        |
| 206.6 Proposed fail-safe on ordinary exit                             | Rely exclusively on restart; best-effort restoration            | Graceful stop restores a live container's remembered base, guarded by matching execution attempt and owned cap. SIGKILL recovery relies on supervision/resume. |
| 206.7 Optional JSON recovery report                                   | New output contract; existing watcher attachment report         | Keep existing reattachment output; recovery is verified through CPU state/status. No new CLI option is needed.                                                 |
| Cross-cutting: cover entire codebase                                  | Fix detached JS only                                            | JS and Rust policy, locks, monitors, attached/untracked launchers, resume resource restoration, shared contracts, manifest and release fragments.              |

Working checklist:

- [x] Read all scope, comments, contribution instructions, current PR, and related merged work.
- [x] Research primary Docker/Linux/component documentation and compare alternatives.
- [x] Record failing minimal regressions for each defect before implementation.
- [x] Implement JavaScript policy, adapter, supervision, lock and resume changes.
- [x] Maintain Rust behavior and shared golden contracts in the same change.
- [x] Run JavaScript lint/format/full tests, parity/workflow checks and genuine generation check.
- [x] Run finite Docker probes; retain failures and limits.

Final commit, main ancestry, clean worktree, same-commit CI results and readiness
are recorded in [PR 208](https://github.com/link-foundation/start/pull/208).
See [validation](validation.md) for reproduction commands and raw local evidence.

Experiments are finite, use temporary fixtures, clean up children, and do not stress
host memory/stack. Native compilation is delegated to the adequately provisioned
existing CI stage after JavaScript succeeds; local Rust formatting is lightweight.
