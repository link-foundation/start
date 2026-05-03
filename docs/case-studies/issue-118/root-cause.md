# Root cause analysis

This document covers the *recent* failures captured in `recent-runs.json`
and `ci-logs/`. Earlier history is summarised in `timeline.md`.

## RC-1 — `merge-changesets.mjs` crashed with ENOENT on the `.changeset` dir

**Failure:** run [25263794761](https://github.com/link-foundation/start/actions/runs/25263794761),
JS workflow, push event on `main` (commit `fb98f01`).

**Symptom (verbatim from the log):**

```
Error: ENOENT: no such file or directory, scandir '.changeset'
    at readdirSync (node:fs:1505:26)
    at /home/runner/work/start/start/scripts/merge-changesets.mjs:189:26
```

**Root cause:** the script was written before the JS code moved into a
`js/` subfolder. It assumed the `.changeset` directory lived at the
repository root next to `package.json`. After the monorepo split, the
file actually lives at `js/.changeset`, so `readdirSync('.changeset')`
threw at the very first read.

**Fix in tree:** PR #117 (`a5304e6`). The script now:

1. Accepts `--working-dir <dir>` (defaults to `.`, env var
   `WORKING_DIR`).
2. Resolves `<workingDir>/package.json` to read the package name.
3. Scans `<workingDir>/.changeset` for fragment files.

The release workflow now calls
`node scripts/merge-changesets.mjs --working-dir js`. Verified by the
green run [25277495071](https://github.com/link-foundation/start/actions/runs/25277495071).

## RC-2 — Older JS releases lack the per-version npm badge

**Failure:** `js-v0.25.5` and `js-v0.26.0` exist as GitHub Releases
with body content but no per-version `start-command/v/<version>` npm
badge. (Earlier drafts of this case study claimed the missing-badge
problem also affected `rust-v0.13.0` and `rust-v0.14.0`. Those tags
were never pushed and no GitHub release object exists for either
version, so there is nothing to back-fill — `gh release view <tag>
--json body` returns `release not found`, which an earlier automated
check incorrectly read as a 12-character "empty body".)

**Root cause:** these releases were created before
`create-github-release.mjs` learnt to extract per-version notes from
`<lang>/CHANGELOG.md` and append the npm/crates.io badge. The release
was created with `gh release create … --notes "<changelog excerpt>"`
without the badge embed step that the current script performs.

**Fix in tree:** the release script now takes `--changelog-file
js/CHANGELOG.md --badge-type npm --package-name start-command`
(verified on `js-v0.27.0`).

**Remaining work:** the two old JS releases need their bodies
back-filled. PR #119 ships `scripts/backfill-release-notes.mjs`,
which given a tag regenerates the release body from the same sources
`create-github-release.mjs` would use today. See
`backfill-recipe.md` for the exact one-shot invocation.

## RC-3 — Release jobs silently skip when transitive dependencies use `if: always()`

**Failure mode:** before PR #115, the Rust `auto-release` job declared
`needs: [lint, test, build]`. Because `test` itself uses `if: always()`,
GitHub Actions propagated `skipped` down the chain and `auto-release`
ran but had no real conditions to release on, so no Rust release was
ever created.

**Root cause:** `if: always()` upstream + a downstream `if:` that does
not explicitly handle the propagated `skipped` state. The fix is a
pattern: `if: always() && !cancelled() && needs.X.result == 'success'`.

**Fix in tree:** the Rust workflow already uses this pattern on both
`auto-release` and `manual-release`. The JS `release` job uses the
older `if: always() && needs.lint.result == 'success' && needs.test.result == 'success'`
form which is functionally equivalent for our case but does not
distinguish "skipped because cancelled" from "skipped because of
dependency". PR #119 normalises both workflows to use `!cancelled()`.

## RC-4 — Credential errors are buried inside vendor tools

**Failure mode:** when a release job runs without
`permissions.id-token: write`, npm OIDC publishing fails with a generic
"could not get OIDC token" error from inside `npm publish`. The
operator has no obvious way to tell whether the token is missing,
expired, or denied.

**Root cause:** the workflow does not pre-check the credentials it is
about to use. It only discovers the problem when the consumer tool
tries to use them.

**Fix in tree (PR #119):** new `scripts/preflight-credentials.mjs`
runs before any publish step, asserting:

- `GITHUB_TOKEN` (or `GH_TOKEN`) is set.
- `id-token: write` is implied (workflow declares it; we cannot
  introspect at runtime, but we can mint a test OIDC token and
  fail loudly if that mint fails).
- The npm registry is reachable.

The script prints `::error::` lines on missing credentials so they
appear at the top of the run summary instead of in step logs.

## RC-5 — No verification that the badge actually appears in the release

**Failure mode:** even with the badge correctly added by
`create-github-release.mjs`, nothing checks the published release. If a
future regression strips the badge, the next release would silently
ship without it (the original "false positive" the issue describes).

**Root cause:** there's no post-condition assertion on the release
body.

**Fix in tree (PR #119):** new `scripts/verify-release-badge.mjs` runs
after `create-github-release.mjs`. It fetches the release body via the
GitHub API, asserts the badge URL is present, and fails the job
otherwise.
