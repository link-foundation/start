# Timeline — Issue #120

All times in UTC.

## 2026-05-03 13:35 — PR #119 merged to `main`

- PR #119 ("CI/CD hardening from issue #118") merged via commit
  `9ac532dea2da8279e4fe53b69fc2591cfc225e38`.
- This is the first commit on `main` that runs the new
  `scripts/preflight-credentials.mjs` step inside both release jobs.
- The PR's check runs were green (run IDs 25280626742 and 25280626738) because
  the failing path (release / auto-release) only triggers for `push` events on
  `main`, not for `pull_request` events.

## 2026-05-03 15:18 — `push` to `main` triggers both pipelines

- Run [25282945820](https://github.com/link-foundation/start/actions/runs/25282945820)
  (Rust CI/CD) — job *Auto Release* (74123130954).
- Run [25282945817](https://github.com/link-foundation/start/actions/runs/25282945817)
  (JavaScript CI/CD) — job *Release* (74123037678).
- All quality jobs (lint, tests, coverage, build, parity) pass on every OS.
- Both release jobs fail at the **Preflight credential checks** step within
  ~330 ms of starting it:

  ```
  ##[error]Preflight check failed (gh-token): `gh api user` rejected the
  token (HTTP error or expired). Underlying: Command failed: gh api user
  --jq .login
  ```

- The preceding step group prints:

  ```
  ##[group]GITHUB_TOKEN Permissions
  Contents: write
  Metadata: read
  ##[endgroup]
  ```

  i.e. `secrets.GITHUB_TOKEN` is present and has `metadata: read` and
  `contents: write` — but no scope on `/user`.

## 2026-05-03 17:21 — Issue #120 opened

- Konstantin Diachenko (@konard) files issue #120 with both failing run links
  and a request to compare with the upstream pipeline templates.

## 2026-05-03 17:22 — Branch `issue-120-22538e16da80` created

- AI issue solver checks out a fresh branch from `main`, opens draft PR #121.

## What changed between "green PR run on issue-118" and "red push run on main"

The same code, different event:

- The PR runs against `issue-118-4ed21210786f` only invoked the *quality*
  jobs (lint, test, coverage, parity, syntax-check, simulate-merge).
- The release jobs are gated on `github.event_name == 'push' && github.ref ==
  'refs/heads/main'`, so they only run after merge.
- Therefore, the regression in `preflight-credentials.mjs` was first exercised
  on the production token *after* the merge.

This is the underlying class of bug — *"PR-time CI cannot validate
release-time credentials"* — and it is recorded as a follow-up requirement
in `requirements.md`.
