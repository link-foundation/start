# Case Study — Issue #162: a detached container was a dead end

- Issue: https://github.com/link-foundation/start/issues/162
- Pull request: https://github.com/link-foundation/start/pull/163
- Downstream consumer: https://github.com/link-assistant/hive-mind/issues/2189
- Related prior work: #144, #148, #151

## Result

Everything needed to recover a crashed detached session already survived: the
execution record, the log file, and the retained container with its 27 GB
writable layer. The gap was purely in the verbs the CLI offered. `--status`,
`--stop`, `--terminate` and `--upload-log` can all inspect or end a session;
none of them can re-enter one. The failure guidance pointed at raw Docker, and
both suggestions were wrong for the situation that produced them: `docker exec`
requires a running container, and `docker start -ai` re-runs the original
entrypoint from the beginning.

This PR adds the missing verbs to both implementations:

| Verb                         | Behaviour                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `--attach <id>`              | Re-enter a live detached session's terminal.                                  |
| `--attach <id> --read-only`  | Follow its output without forwarding stdin.                                   |
| `--resume <id>`              | Continue the stored command in the same container filesystem.                 |
| `--resume <id> -- <command>` | Run a _different_ command in that same filesystem context.                    |
| `--resume-all`               | Re-attach or reconcile every execution still marked running.                  |
| `--list --running`           | The machine-readable set that drives `--resume-all`.                          |
| `exitReason`                 | A hint (e.g. `memory-exhaustion (v8-heap-limit)`) parsed from the log footer. |

A resume keeps the original execution UUID and appends the old container name to
`sessionNameHistory`, so `--status`, `--list` and `--upload-log` keep addressing
one logical session across restarts instead of fragmenting into unrelated
records. `exitReason` is strictly additive: it never changes `status`,
`exitCode` or `oomKilled`, preserving the #148/#151 rule that `State.OOMKilled`
is an observation and never a verdict.

## Documents

| File              | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `requirements.md` | Complete requirement inventory and disposition.                           |
| `timeline.md`     | Event sequence reconstructed from the incident and GitHub metadata.       |
| `root-cause.md`   | Why each capability was missing, and why `exitCode 139` misled consumers. |
| `solutions.md`    | Alternatives considered, the selected design, and the verification plan.  |
| `data/`           | Issue, PR, diff, and local verification evidence.                         |
| `ci-logs/`        | Branch workflow logs, including the CodeQL run behind the triage.         |

## Evidence highlights

- `data/issue-162.json` records the incident verbatim: `exitCode 139`,
  `oomKilled false`, `sessionName dd1acfbe-3c01-4ffa-8c78-f825457f5813`, and the
  `docker exec` / `docker start -ai` guidance that could not help.
- `data/issue-162-comments.json` names the downstream consumer that recovers a
  tool session id from a killed run but cannot re-enter the preserved container.
- `data/branch-diffstat.txt` shows the change is additive: 7164 insertions
  against 791 deletions, the deletions being the extraction of existing
  dispatch code into `query-commands` / `query_commands` modules.
- `data/js-focused-test.log` and `data/rust-focused-test.log` record the two
  end-to-end regression suites (13 JavaScript cases, 14 Rust cases) driving the
  real CLI against a temporary `START_APP_FOLDER`.
- `data/local-js-full.log` (838 pass / 0 fail) and `data/local-rust-full.log`
  (28 green test binaries, 245 library cases) record the full local suites.
- `data/local-test-parity.log` shows 827 Rust cases against 780 JavaScript
  cases, a 106.0% ratio against the required 90% minimum.
- `data/codeql-alerts-pr-163.json` holds the 11 `rust/cleartext-logging` alerts
  the CodeQL gate raised on the branch and the reason each was dismissed. All 11
  flag the execution UUID, which CodeQL's account-information heuristic matches
  because `uuid` contains `uid`; `solutions.md` traces the heuristic and records
  why the rule was left enabled rather than filtered away.

No upstream defect was filed. Docker behaves as documented: `exec` requires a
running container, `start -ai` restarts the entrypoint, and the kernel OOM
killer genuinely did not fire. The defect was this project's missing recovery
surface.
