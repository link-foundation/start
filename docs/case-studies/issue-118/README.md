# Case Study: Issue #118 — Fix all CI/CD issues

> Repository: [link-foundation/start](https://github.com/link-foundation/start)
> Issue: [#118 — Fix all CI/CD issues](https://github.com/link-foundation/start/issues/118)
> PR:     [#119](https://github.com/link-foundation/start/pull/119)
> Branch: `issue-118-4ed21210786f`

## Scope

The issue requested a sweep of the CI/CD pipeline to (a) make per-language
releases unambiguous, (b) put exact-version package badges in every
relevant surface (READMEs, GitHub Releases), (c) make missing or expired
credentials fail loudly, (d) close the gap between this repo and the
official link-foundation pipeline templates, and (e) collect everything
that informed the analysis so the next investigation can pick it up
where this one stopped.

## Files in this folder

```
docs/case-studies/issue-118/
├── README.md                         (this file)
├── timeline.md                       Sequence of events on main
├── requirements.md                   Each requirement extracted from the issue
├── root-cause.md                     Root causes for the most-recent failures
├── solutions.md                      Solution plan for each requirement
├── comparison-with-templates.md      Per-feature gap analysis vs. templates
├── issue-data.json                   Raw `gh issue view` output
├── issue-comments.json               Issue comment thread (currently empty)
├── recent-runs.json                  Last ~30 CI runs across both workflows
├── releases-list.json                All releases with tags/titles
├── ci-logs/
│   └── js-failure-25263794761.log    The most recent failed run on main
└── releases/
    ├── js-v0.27.0.txt                Latest JS release body (with badge)
    └── rust-v0.14.1.txt              Latest Rust release body (with badge)
```

For tags that have **no** release object (`rust-v0.13.0`, `rust-v0.14.0`)
see the note in [`backfill-recipe.md`](./backfill-recipe.md) — earlier
drafts mistakenly listed them as "empty body" releases because
`gh release view <tag> --json body` prints the literal string
`release not found` when the release does not exist.

## Headlines

1. **Latest releases now carry version-specific badges** — `js-v0.27.0` and
   `rust-v0.14.1` both render the per-version npm / crates.io badge.
   The two older JS releases that *do* exist on GitHub but were cut
   before badges were wired in (`js-v0.25.5`, `js-v0.26.0`) lack the
   per-version badge and can be back-filled with the recipe in
   [`backfill-recipe.md`](./backfill-recipe.md). For `rust-v0.13.0`
   and `rust-v0.14.0` no GitHub release object was ever created, so
   there is nothing to PATCH; PR #119's `verify-release-badge.mjs`
   guard prevents the same gap recurring on future cuts.
2. **The most recent CI failure on `main` was already fixed** — Run
   [25263794761](https://github.com/link-foundation/start/actions/runs/25263794761)
   crashed in `merge-changesets.mjs` because the script was scanning
   `./.changeset` instead of `js/.changeset`. PR #117 made the script
   `--working-dir`-aware.
3. **The repo is materially behind the templates** —
   [`comparison-with-templates.md`](./comparison-with-templates.md) lists
   every check the templates run that this repo skips (timeouts,
   `simulate-fresh-merge.sh`, `check-mjs-syntax.sh`, secretlint, jscpd,
   self-healing release detection on npm and crates.io, Deno coverage of
   the test matrix, modern action versions, modern Node).
4. **Credential failures are silent** — `setup-npm.mjs`,
   `publish-to-npm.mjs`, and `create-github-release.mjs` all assume the
   relevant tokens are present; when `GH_TOKEN` is missing or
   `id-token: write` is unavailable, the failure is buried inside `gh`
   or `npm` output rather than surfaced as a clear `::error::` line.

[`solutions.md`](./solutions.md) lays out the implementation plan that
PR #119 ships.
