# Case Study: Issue #108 — No Rust releases, no badges, no language prefixes

## Summary

Issue #108 reports three visibility problems for the Rust half of this
mono-repository:

1. **No Rust releases** exist on GitHub — only `v0.x.y` releases (all from the
   JavaScript package `start-command`) are present.
2. **No language badges** (npm, crates.io, docs.rs, codecov, etc.) are shown
   anywhere in the README tree, and there are no per-language `js/README.md`
   or `rust/README.md` files.
3. **Release titles and tags are not language-prefixed**. All releases use
   `v0.x.y` — a reader cannot tell which release belongs to which language,
   and a future `rust/` release would collide with the next `js/` release.

The issue also asks us to:

- compare the repository's CI/CD workflows with the upstream templates
  (`js-ai-driven-development-pipeline-template` and
  `rust-ai-driven-development-pipeline-template`),
- reuse best practices,
- file issues on the template repositories if the same problems exist there,
- compile all gathered data into this folder,
- and add verbose/debug output if the data we have is not sufficient to find
  a root cause.

## Contents

- [timeline.md](timeline.md) — reconstruction of the sequence of events.
- [requirements.md](requirements.md) — explicit list of every requirement
  pulled from the issue text.
- [root-cause.md](root-cause.md) — the three independent root causes behind
  the single observable symptom.
- [solutions.md](solutions.md) — the solution plan and the trade-offs that
  were considered for each root cause.
- [templates/](templates/) — snapshots of the upstream template workflows
  that were reviewed during this analysis.
- `issue-data.json`, `issue-comments.json`, `releases.json` — raw data
  downloaded from the GitHub API for reproducibility.

## Reproduction

```bash
# 1. No Rust-tagged releases
gh release list --repo link-foundation/start --limit 100 | grep -E '^rust-' || echo "no rust-* releases"

# 2. Rust workflow auto-release never ran
gh run list --repo link-foundation/start --workflow=rust.yml --branch main \
  --json databaseId,conclusion --limit 5
gh api repos/link-foundation/start/actions/runs/<run-id>/jobs \
  --jq '.jobs[] | {name, conclusion}'
# => "Auto Release" is always "skipped", even though lint/test/build all succeed.

# 3. --prefix argument is ignored by create-github-release.mjs
grep -n 'prefix' scripts/create-github-release.mjs || echo "prefix is never read"
```

## High-level findings

| Symptom                                    | Root cause                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| No Rust release ever created               | `rust.yml` job `auto-release` has `if: github.event_name == 'push' && …` without `always()` — it is auto-skipped  |
| Release titles/tags have no language prefix | `scripts/create-github-release.mjs` declares no `--prefix` option in yargs; the flag is silently dropped          |
| No badges in READMEs, no per-lang READMEs  | The repository never had `js/README.md` or `rust/README.md`; the root README lists only JS installation steps     |

Each root cause is independent, so each is addressed by its own commit in the
pull request that fixes this issue.

## See also

- Issue: https://github.com/link-foundation/start/issues/108
- PR:    https://github.com/link-foundation/start/pull/109
