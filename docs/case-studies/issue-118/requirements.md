# Requirements extracted from issue #118

Numbered exactly as they appear in the issue body so each can be tracked
independently.

## R1 — Per-language READMEs with latest-version badges

> "We should have language specific readme for each language, with badges
> for latest package versions in each one."

**Status (start of work):** `js/README.md` and `rust/README.md` already
exist with shields.io badges:

- `js/README.md` — `npm version`, `npm downloads`, JS CI badge,
  Unlicense badge.
- `rust/README.md` — `crates.io`, `docs.rs`, Rust CI badge, Unlicense
  badge.

**Gap:** badges currently link to "latest"; the issue text reads as
"badges for latest" so this is met. We will tighten the existing badges
(consistent style, query the registry directly) but no structural change
is required.

## R2 — Main README with badges of "all" packages with direct links

> "The main README.md file should contain badges of packages of all
> versions with direct links to package registries."

**Status:** `README.md` carries 5 badges (JS CI, Rust CI, npm version,
crates.io, Unlicense). All of them link to the registry.

**Gap:** the wording "badges of all versions" is plural — likely means
"every package" (we have two: npm + crates.io), not "every published
version". Both are present. Verifying with the user is unnecessary
because both registries are already linked.

## R3 — Clear, language-prefixed GitHub Releases with per-release badges

> "We should have clear GitHub releases separate for each language, with
> release specific badges in description, title and tags should be
> prefixed like we do with our templates."

**Status:** PR #115 already implemented language-prefixed tags
(`js-v…` / `rust-v…`) and titles (`[JavaScript] …` / `[Rust] …`), and
`create-github-release.mjs` accepts `--badge-type` + `--package-name`
to embed the per-version badge. Verified on `js-v0.27.0` and
`rust-v0.14.1` (see `releases/`).

**Gap:** the older JS releases `js-v0.25.5` and `js-v0.26.0` predate
the badge change and lack the per-version npm badge — the user-facing
"false positive" the issue mentions. Solution: back-fill those release
bodies (recipe in `backfill-recipe.md`). The Rust side has only a
single published release (`rust-v0.14.1`); the `rust-v0.13.0` /
`rust-v0.14.0` versions referenced in earlier drafts of this case
study were never tagged or released, so there is nothing to back-fill
on that side.

## R4 — False-positive guard ("did the release actually happen")

> "We also need to check for false positives. For example latest Rust
> GitHub release didn't contain badge for specific version, so it is
> hard to check if release was actually done."

**Status:** the badge is the visual signal. PR #115 made it part of the
template, but nothing verifies the badge appears after the release is
created.

**Gap:** add a post-release verification step that reads the freshly
created release body, confirms the badge is present, and fails the job
otherwise. This is the false-positive guard the issue asks for.

## R5 — Surface missing/expired credentials clearly

> "Double check if credentials are not set or expired, we clearly show
> that in error messages and clearly fail CI/CD."

**Status:** today the failure modes are:

- Missing `GITHUB_TOKEN`: `gh api` exits with `HTTP 401` printed deep in
  the log.
- Missing `id-token: write` permission for npm OIDC: `npm publish`
  errors with a confusing OIDC token error.
- Expired npm trusted publisher record: the same OIDC error.

**Gap:** add a "preflight" step at the top of every release job that
asserts each required token / permission and fails with a single
`::error::` line naming what is missing.

## R6 — Adopt template best practices and report gaps upstream

> "Use all the best practices from CI/CD templates (check full file tree
> to compare for all GitHub workflow and CI/CD scripts file), if the
> same issue is found in template report issue also in templates."

**Status:** the templates are well ahead of this repo (newer action
versions, per-job timeouts, fast-fail ordering, secretlint, jscpd, fresh
merge simulation, npm/crates.io self-healing release detection).

**Gap:** see `comparison-with-templates.md` for the full list. The
solution adopts the high-impact items (timeouts, action upgrades,
self-healing release detection, fresh-merge simulation, syntax
pre-check). None of the gaps appear to be bugs in the templates
themselves; the templates are in fact the *source* of best practice, so
no upstream issues are needed for this round.

## R7 — Compile a deep case study under `docs/case-studies/issue-{id}`

> "We need to download all logs and data related about the issue to this
> repository, make sure we compile that data to ./docs/case-studies/
> issue-{id} folder, and use it to do deep case study analysis."

**Status:** none.

**Gap:** the entire `docs/case-studies/issue-118/` tree is the answer.
Includes raw data (`*.json`, `ci-logs/*.log`, `releases/*.txt`) and
analysis (`README.md`, `timeline.md`, `requirements.md`,
`root-cause.md`, `solutions.md`, `comparison-with-templates.md`).

## R8 — Add debug/verbose modes where they're missing

> "If there is not enough data to find actual root cause, add debug
> output and verbose mode if not present, that will allow us to find
> root cause on next iteration."

**Status:** scripts mostly print success messages but not the inputs
they used (working dir, package name, token presence).

**Gap:** add a `DEBUG=1` flag to the highest-risk scripts
(`publish-to-npm.mjs`, `create-github-release.mjs`,
`merge-changesets.mjs`) that prints the resolved arguments and a token
presence summary (without leaking the token itself).

## R9 — Plan and execute everything in a single PR

> "Please plan and execute everything in a single pull request."

**Status:** PR #119 already exists on `issue-118-4ed21210786f`.

**Gap:** finalise it (description, mark ready, link this case study).
