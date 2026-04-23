# Solutions — Issue #108

For each root cause identified in [`root-cause.md`](root-cause.md) we
considered two or three options before picking the one shipped in
PR #109.

## RC1 — `auto-release` job is silently skipped

| Option | Verdict |
|--------|---------|
| A. Add `always() && !cancelled() && needs.build.result == 'success'` to the `if` condition of `auto-release` (this is what the upstream `rust-ai-driven-development-pipeline-template` does). | **Chosen.** Minimal, surgical, matches existing upstream best practice. |
| B. Remove `if: always()` from the `build` job so that the `skipped` status doesn't propagate. | Rejected — `build` needs `always()` to run after a matrix `test`. |
| C. Move `auto-release` into its own workflow triggered by `workflow_run`. | Rejected — too large a refactor for the scope of this issue. |

### Candidate libraries / actions

No third-party action is needed; this is a workflow-YAML one-liner.

## RC2 — `--prefix` ignored by release scripts

| Option | Verdict |
|--------|---------|
| A. Add a declared `--prefix` option to `scripts/create-github-release.mjs` and `scripts/format-github-release.mjs`, and use it when constructing the tag and release name. | **Chosen.** Keeps the single-script design used by both workflows. |
| B. Fork the scripts into `scripts/create-github-release-{js,rust}.mjs`. | Rejected — duplicates code and drifts from upstream templates. |
| C. Move the tag construction into the workflow YAML and pass the completed tag to the script. | Rejected — the script also has to look up changelog entries by version; passing both the version and the prefixed tag would complicate every call site. |

### Candidate libraries / tooling

`yargs` (via `lino-arguments`) already supports the missing option; no
new dependency is required. `gh api` already accepts the tag as plain
text, no escaping issues.

## RC3 — Missing per-language READMEs / badges

| Option | Verdict |
|--------|---------|
| A. Add `js/README.md` and `rust/README.md` with per-manager badges and link them from the root README. | **Chosen.** |
| B. Consolidate everything in the root README. | Rejected — issue explicitly asks for per-language READMEs. |
| C. Use `shields.io` "dynamic" badges that auto-detect the published version. | Partially adopted — the npm and crates.io badges already do that automatically. |

### Badge catalogue

Badges picked match the ones used by the upstream templates:

- **JS** (`js/README.md`): npm version, npm downloads, CI/CD workflow,
  license (Unlicense).
- **Rust** (`rust/README.md`): crates.io version, docs.rs, CI/CD
  workflow, license (Unlicense).

Both READMEs also link back to the project-wide root README and to
`docs/PIPES.md` / `docs/USAGE.md` so users always land in the right
language-specific place.

## Sequencing

The three fixes are independent, but to actually observe a successful
Rust release on the next `main` push, all three are required:

1. `auto-release` must run (RC1).
2. The release it creates must use the correct tag/title (RC2).
3. Readers of the GitHub repo must be able to find the crates.io page
   (RC3 — optional for the publish, mandatory for discoverability).

## Verification

After PR #109 lands on `main`, the next push that touches `rust/**`
should:

```bash
$ gh api repos/link-foundation/start/actions/runs/<next-rust-run>/jobs \
    --jq '.jobs[] | {name, conclusion}'
# => "Auto Release" has conclusion: "success" (not "skipped")

$ gh release list --repo link-foundation/start --limit 5
# => includes a new entry titled "[Rust] 0.14.0" with tag "rust-v0.14.0"

$ git tag --list "rust-*"
# => rust-v0.14.0 (or whatever version the changelog fragments bump to)
```
