# Solution plan

This is the implementation plan PR #119 ships. Each item maps back to a
requirement in `requirements.md`.

## S1 — Back-fill `js-v0.25.5` and `js-v0.26.0` release notes (R3, R4)

`scripts/backfill-release-notes.mjs` regenerates a release body from
the language-specific `CHANGELOG.md` and the same badge template
`create-github-release.mjs` uses, then PATCHes the GitHub release via
`gh api repos/:owner/:repo/releases/:id`.

The exact one-shot recipe lives in [`backfill-recipe.md`](./backfill-recipe.md).
The two affected releases are `js-v0.25.5` and `js-v0.26.0` — they
exist with body content but were cut before badges were wired in.

> **Why no Rust back-fill?** Earlier drafts of this case study planned
> to back-fill `rust-v0.13.0` and `rust-v0.14.0` too. They were dropped
> from this list because verification (`gh release list`,
> `git ls-remote --tags origin`) showed neither the release object nor
> the git tag was ever pushed. There is nothing to PATCH; PR #119's
> `verify-release-badge.mjs` guard prevents the same drift recurring
> on the next Rust release.

The script is a one-off but lives in `scripts/` so it's reusable for
future drift.

## S2 — Verify badge appears in the release body (R4)

`scripts/verify-release-badge.mjs` runs after
`create-github-release.mjs`. It:

1. Fetches the release body via `gh api`.
2. Looks for the exact badge URL the script would have generated for
   `(packageType, packageName, releaseVersion)`.
3. Fails with `::error::Release ${tag} is missing the expected badge`
   if not found.

Wired into both JS and Rust release jobs.

## S3 — Preflight credentials (R5)

`scripts/preflight-credentials.mjs` runs at the top of every job that
touches an external service:

- `--require gh-token` — asserts `GITHUB_TOKEN` or `GH_TOKEN` is set
  and is a non-empty string. Pings `gh api user` to detect expired
  tokens.
- `--require npm-oidc` — calls the action's OIDC endpoint to mint a
  test token. Failure means `id-token: write` is missing or trusted
  publishing is misconfigured.
- `--require crates-io` — reachability check against
  `https://crates.io/api/v1/crates/start-command`.

Each check emits an `::error::` line on failure. The script exits
non-zero so the job halts with a clear summary instead of failing inside
`gh` / `npm` later.

## S4 — Self-healing release detection (R6)

`scripts/check-release-needed.mjs` (ported from the JS template,
adapted for `--working-dir js`) queries the npm registry rather than
git tags. It writes `should_release` and `skip_bump` to
`GITHUB_OUTPUT`. If `package.json` has a version that npm doesn't know
about, the next push to `main` recovers automatically without needing a
new changeset.

For Rust, a sibling Node script (also called
`check-release-needed.mjs` but invoked with `--working-dir rust
--registry crates.io`) hits the crates.io HTTP API and writes the same
outputs.

## S5 — Per-job timeouts and modern action versions (R6)

Every job in `.github/workflows/{js,rust}.yml` gets:

- `timeout-minutes: 5` for "fast" jobs (detect-changes, syntax check,
  version-check, file-size).
- `timeout-minutes: 10` for "lint", "changeset/changelog check", "test"
  (matrix).
- `timeout-minutes: 30` for "release", "build", "coverage" (which can
  pull cargo-tarpaulin).

`actions/checkout` and `actions/setup-node` upgrade from `@v4` to
`@v6`. Node bumps from `20.x` to `24.x`.

## S6 — Fast-fail ordering and `!cancelled()` (R6)

The release job already used `!cancelled()`-equivalent guards. The test
job(s) get the same treatment:

```yaml
if: |
  !cancelled() &&
  (github.event_name == 'push' || needs.changeset-check.result == 'success' || needs.changeset-check.result == 'skipped') &&
  (needs.test-compilation.result == 'success' || needs.test-compilation.result == 'skipped') &&
  (needs.lint.result == 'success' || needs.lint.result == 'skipped')
```

## S7 — `simulate-fresh-merge.sh` and `check-mjs-syntax.sh` (R6)

Both scripts ported verbatim from the JS template (they're shell-only
and don't depend on layout). Wired into the lint, test-compilation,
and check-file-line-limits jobs.

## S8 — Debug / verbose mode (R8)

A new helper `scripts/debug-print.mjs` exposes
`debug(label, value)` and `debugSummary(env)` and is no-op unless
`DEBUG=1`. Callers (`publish-to-npm.mjs`, `create-github-release.mjs`,
`merge-changesets.mjs`) print the resolved arguments and a token
presence summary on first call.

## S9 — Tighten READMEs (R1, R2)

`README.md` and the per-language READMEs already meet the requirement.
This PR keeps them as-is *except* for adding the link to this case
study from the project root README so the next investigator finds it
quickly.

## S10 — Finalise PR #119 (R9)

- Update PR title from `[WIP] Fix all CI/CD issues` to `Fix all CI/CD
  issues`.
- Replace the placeholder body with a summary that links to this case
  study folder.
- Mark the PR ready for review.

## Out of scope (tracked as follow-ups)

- Multi-runtime JS test matrix (Node + Deno alongside Bun) — code uses
  Bun-only APIs.
- Publishing the Rust crate to crates.io. The Rust README still says
  "planned as a follow-up". This is a credentials task (CARGO_REGISTRY_TOKEN
  + crates.io trusted publishing setup) for which the user has reserved
  manual handling per the issue text ("I will handle that manually
  later").
