# Timeline of CI/CD events leading to issue #118

All times in UTC.

## 2026-04-29 17:25 — Rust CI starts failing on `main`

- Run [25123717560](https://github.com/link-foundation/start/actions/runs/25123717560)
  on commit `f53dfb2` fails in the Rust workflow.
- JS workflow on the same commit succeeds.
- This is the first failure in the run history captured by
  `recent-runs.json`.

## 2026-05-02 07:24 — Both pipelines fail on `main`

- Push of commit `19784b1` fails in **both** Rust (run
  [25246804647](https://github.com/link-foundation/start/actions/runs/25246804647))
  and JS (run [25246804640](https://github.com/link-foundation/start/actions/runs/25246804640)).
- This is what motivated issue #114 ("repair release ci automation").

## 2026-05-02 11:01 — PR #115 (issue #114) merges fix into `main`

- PRs #115 and #117 (issue-114-…) restored the JS and Rust release
  pipelines: language-prefixed tags (`js-v…`, `rust-v…`),
  language-prefixed titles (`[JavaScript] …`, `[Rust] …`), and badges
  in release notes.
- After this point, both PR runs go green.

## 2026-05-02 22:47 — JS release on `main` fails

- Run [25263794761](https://github.com/link-foundation/start/actions/runs/25263794761)
  on commit `fb98f01` fails inside `merge-changesets.mjs` with
  `Error: ENOENT: no such file or directory, scandir '.changeset'`.
- `ci-logs/js-failure-25263794761.log` contains the full transcript.
- Root cause: the script defaulted to `process.cwd()/.changeset`
  (the repo root) instead of `js/.changeset` after the monorepo
  restructure.

## 2026-05-03 10:52 — PR #117 (issue #116) merges fix into `main`

- PR #117 makes `merge-changesets.mjs` `--working-dir`-aware and
  reads the package name from the language subfolder's `package.json`.
- Both pipelines go green again.

## 2026-05-03 11:07 — JS pipeline publishes `js-v0.27.0`

- Run [25277495071](https://github.com/link-foundation/start/actions/runs/25277495071)
  on `main` succeeds. The release body contains the
  `start-command/v/0.27.0` npm badge as expected.

## 2026-05-03 11:09 — Rust pipeline notices nothing to publish

- Run [25277495058](https://github.com/link-foundation/start/actions/runs/25277495058)
  succeeds (no Rust source changed).

## 2026-05-03 13:01 — Issue #118 opened

- The issue requests a comprehensive CI/CD sweep, asks for a deep case
  study under `docs/case-studies/issue-{id}`, and points at the four
  template repositories as the bar to clear.

## State as of this case study

- `main` is green for both pipelines on commit `7a6d8b9`.
- Latest releases (`js-v0.27.0`, `rust-v0.14.1`) include per-version
  badges in their release bodies.
- Older JS releases `js-v0.25.5` and `js-v0.26.0` exist but lack the
  per-version npm badge — they were cut before PR #115 wired badges
  into `create-github-release.mjs`. They are documented in
  `backfill-recipe.md`.
- For Rust, the only published release on GitHub is `rust-v0.14.1`.
  Earlier drafts of this case study assumed `rust-v0.13.0` and
  `rust-v0.14.0` existed with empty bodies, but `gh release list`
  and `git ls-remote --tags origin` confirm neither the release
  object nor the git tag was ever pushed.

## What changed between failure and recovery

| Failure run | Fixed by | Mechanism |
| --- | --- | --- |
| 25246804647 (Rust release silently skipped) | PR #115 | `auto-release.if` gained `always() && !cancelled()` so the release job no longer inherits `skipped` from a transitive `if: always()` dependency. |
| 25263794761 (JS `merge-changesets.mjs` ENOENT) | PR #117 | `merge-changesets.mjs` now takes `--working-dir js`, reads `js/package.json`, and scans `js/.changeset`. |
| `js-v0.25.5` / `js-v0.26.0` GitHub releases lack per-version npm badge | PR #115 (forward-fix), PR #119 (back-fill) | `create-github-release.mjs` started writing the badge into release bodies; older releases need a one-shot back-fill via `scripts/backfill-release-notes.mjs` (see `backfill-recipe.md`). |
