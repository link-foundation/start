# Comparison with `link-foundation/*-pipeline-template` and `link-assistant/hive-mind`

This file is a side-by-side audit of every workflow-level practice that the
issue calls out. Where this repo already matches the template, that's noted;
where it does not, the gap is closed in this PR or recorded as future work.

## Repos compared

| Source | URL | Workflow files |
|---|---|---|
| **this repo** | https://github.com/link-foundation/start | `.github/workflows/{js,rust}.yml` |
| JS template | https://github.com/link-foundation/js-ai-driven-development-pipeline-template | `.github/workflows/{release,links}.yml` |
| Rust template | https://github.com/link-foundation/rust-ai-driven-development-pipeline-template | `.github/workflows/release.yml` |
| Python template | https://github.com/link-foundation/python-ai-driven-development-pipeline-template | `.github/workflows/release.yml` |
| C# template | https://github.com/link-foundation/csharp-ai-driven-development-pipeline-template | `.github/workflows/release.yml` |
| hive-mind reference | https://github.com/link-assistant/hive-mind | `.github/workflows/release.yml` |

## Practices already adopted (verified for this PR)

| Practice | This repo | JS tpl | Rust tpl | hive-mind |
|---|:--:|:--:|:--:|:--:|
| `concurrency.cancel-in-progress` only on non-`main` refs | yes | yes | yes | yes |
| Per-job `timeout-minutes` cap | yes | yes | yes | n/a (uses default) |
| `actions/checkout@v6` (modern node24 support) | yes | yes | yes | hive-mind uses v5 |
| `actions/setup-node@v6` with `node-version: '24.x'` | yes | yes | n/a | yes |
| `id-token: write` permission on the npm publish job | yes | yes | n/a | yes |
| OIDC trusted publishing (no `NPM_TOKEN`) | yes | yes | n/a | yes |
| `if: always() && !cancelled()` guard on release jobs | yes | yes | yes | yes |
| Self-healing release detection vs. registry | yes | yes | yes | yes |
| Detect-changes to skip irrelevant jobs | yes | yes | yes | yes |
| Manual changeset-PR workflow input | yes | yes | n/a | yes |
| Version-modification check (block manual `version` bumps in PRs) | yes | yes | yes | yes |
| Syntax pre-check on `.mjs` (`node --check`) | yes | yes | n/a | yes |
| `simulate-fresh-merge.sh` to surface merge bombs in PRs | yes | yes | n/a | yes |
| Per-version badge in GitHub release notes | yes | yes | yes | yes |
| Post-release verification (`verify-release-badge.mjs`) | yes | yes | yes | yes |

## Practices adopted in this PR

### A1. `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` workflow-level env

**Source:** `link-assistant/hive-mind`
([release.yml:48–49](https://github.com/link-assistant/hive-mind/blob/main/.github/workflows/release.yml#L48-L49)).

**Why:** every job in the failing runs printed:

> Node.js 20 actions are deprecated. The following actions are running on
> Node.js 20 and may not work as expected: `actions/cache@v4`. Actions will
> be forced to run with Node.js 24 by default starting June 2nd, 2026.

This is exactly the case the env var was introduced for — it forces JS-based
actions to use the Node 24 runtime that the runner already ships with, ahead
of GitHub's migration deadline. We add it to both `js.yml` and `rust.yml`.

### A2. `permissions: contents: write` *plus* `pull-requests: write` on the
release jobs that need to update PR labels / comment on PRs

**Source:** JS template, hive-mind. The Rust workflow's `auto-release` and
`manual-release` previously declared only `contents: write`, which is enough
for `gh release create` but not for any future `gh pr comment` (e.g. once we
re-enable per-release announcement comments). Adding the permission is free
because it's scoped to that job.

### A3. Validate the `gh` token via an endpoint that works for installation
tokens (this is the actual fix for the failing runs)

**Source:** GitHub's documented contract for the auto-issued `GITHUB_TOKEN`
— see `root-cause.md`.

The templates do not have a preflight script at all; they let the consuming
tool fail with its own message. Our preflight script is a *strict* superset
of what the templates do. The scope mistake (`gh api user`) was introduced
in PR #119 of this repo and is not present in any template, so no upstream
issue is required.

## Practices intentionally **not** adopted

### N1. `concurrency.cancel-in-progress: ${{ github.ref == 'refs/heads/main' }}` (templates) vs. `… != 'refs/heads/main'` (this repo)

This repo has the *opposite* policy on purpose: keep in-flight `main` runs
alive because they may already be publishing. The trade-off is an edge case
where two consecutive merges both publish, but the `check-release-needed.mjs`
script rejects no-op republishes, so the practical risk is zero. Documented
inline in `js.yml` lines 41–44 and `rust.yml` lines 36–38.

### N2. C# / Python release.yml shapes

Out of scope: this repo only ships JS and Rust artifacts. We read those
two templates anyway and there is no idea in either of them that the JS or
Rust workflow does not already implement.

## Upstream feedback filed

None of the four templates contain the `gh api user` mistake, so there is
nothing to mirror back. We did, however, surface two minor documentation
gaps while reading the templates:

1. **JS template** — `release.yml` job names are sentence-cased ("Test
   Compilation", "Lint and Format Check") but a few (`detect-changes`,
   `version-check`) are kebab-case in the YAML key. This is purely
   stylistic; not filed as an issue.
2. **Rust template** — `check-changelog-fragment.rs` does not document the
   `--base-ref` env var contract anywhere except inline. Also a stylistic
   nit; not filed.

If a real bug is discovered upstream by a future iteration, it should be
filed against the offending template repo with: (a) reproducible failing
run link, (b) workaround, (c) suggested patch — exactly the bar that issue
#120 sets for any external report we file.
