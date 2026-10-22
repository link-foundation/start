# Release jobs skipped on every main push

[Issue #240](https://github.com/link-foundation/start/issues/240) reports that
`Release` in `js.yml` and `Auto Release` in `rust.yml` have been `skipped` on
every push to `main` since #234, even though every job they need succeeded.
Nothing has been published since `0.38.0`. The full issue is in `issue.json`.
`ci-logs/issue-240/run-39555219842-jobs.tsv` holds the job table of one such
main run: every need is `success`, and both release jobs are `skipped`.

## Root cause

Since #234 both release jobs have used:

```yaml
if: |
  !cancelled() && github.ref == 'refs/heads/main' && github.event_name == 'push' &&
  !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled') &&
  !contains(needs.*.result, 'skipped')
```

On a push, `changeset-check` (JS) and `changelog` (Rust) are skipped on purpose.
`test` and `coverage` still run after them through `!cancelled()`, so the
release job's _direct_ needs all succeed. The temporary workflow
`needs-probe.yml` (copied here) reproduces that dependency shape on a pull
request. Run [39678972705](https://github.com/link-foundation/start/actions/runs/39678972705)
(`ci-logs/issue-240/needs-probe-39678972705.log.gz`) shows:

| Probe job                   | Condition                                                    | Result    |
| --------------------------- | ------------------------------------------------------------ | --------- |
| `gate-contains-block`       | `\|` block, three `!contains(needs.*.result, …)` terms       | `skipped` |
| `gate-contains-inline`      | `${{ !cancelled() && !contains(needs.*.result,'skipped') }}` | `skipped` |
| `gate-contains-direct-only` | same check, no skipped ancestor                              | `success` |
| `gate-named`                | `needs.middle.result == 'success' && …`                      | `success` |

The `dump` step of the same run printed `toJSON(needs)` (only the two direct
needs, both `success`) and `contains(needs.*.result, 'skipped')` = `false`.
So the wildcard evaluates differently at job level: there it also sees the
skipped ancestor behind `middle`. Whether the condition is a block scalar or
inline makes no difference. That matches the last release that did run
(`7a89d034`), whose condition compared a named result.

## Fix

- Both release jobs compare each need by name, in a folded `>-` expression,
  for example `needs.test.result == 'success' && needs.coverage.result == 'success'`.
  Run [39680149966](https://github.com/link-foundation/start/actions/runs/39680149966)
  (`ci-logs/issue-240/needs-probe-39680149966.log.gz`) shows that exact folded
  form running (`gate-named-folded`: `success`), and a variant with one false
  term skipping (`gate-named-folded-negative`: `skipped`). The probe was
  removed after that run.
- `pipeline-status` passes `IS_MAIN` and a `--release '<job>:<need>,…'` spec
  to `scripts/check-stage-status.mjs`. The script prints `main push`,
  `toJSON(needs)` and each named term (`needs.test.result=success`), because a
  skipped job logs nothing about its `if`. On a main push it fails when a
  release job was skipped although all of its needs succeeded:
  `release was skipped on a main push although all of its needs succeeded; nothing was released`.
  Rust's `pipeline-status` (Rust Stage) runs the same check for `auto-release`.
- `js/test/ci-workflow-invariants.js` and `rust/tests/ci_workflow_invariants.rs`
  reject `needs.*` in a release condition and require a named success check
  for every need. `js/test/javascript-first-ci.js` checks that the stage
  script fails a skipped main release and passes a skipped release outside
  `main` and a run release on `main`.

## Requirement evidence

| Requirement (issue "Suggested fix")                        | Implementation                                           | Verification                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| 1. Compare each needed result explicitly (JS and Rust)     | `release` in `js.yml`, `auto-release` in `rust.yml`      | Probe run 39680149966; workflow invariant tests in both languages   |
| 2. Confirm the root cause; print `toJSON(needs)` and terms | Probe 39678972705; `check-stage-status.mjs` prints terms | Saved probe logs; `javascript-first-ci.js` checks the printed terms |
| 3. Fail `pipeline-status` on a silently skipped release    | `--release` spec in both stage jobs                      | `javascript-first-ci.js` main/skipped tests                         |

The first main push after merge is the final proof that `Release` runs. The
workaround from the issue (`workflow_dispatch` with `instant-release`) still
works if a release is needed before then.
