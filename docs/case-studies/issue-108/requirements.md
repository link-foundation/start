# Requirements extracted from Issue #108

Each bullet below is a verbatim requirement from the issue text (or a
direct paraphrase of one). The right-hand column points at where the
requirement is satisfied.

| # | Requirement | Satisfied by |
|---|-------------|--------------|
| R1 | Ensure each `js/` and `rust/` (language-specific) folder has its own `README.md`. | New `js/README.md` and `rust/README.md`. |
| R2 | Each language README must display badges for the appropriate package manager. | `js/README.md` shows npm / GitHub Actions / Codecov badges; `rust/README.md` shows crates.io / docs.rs / GitHub Actions / Codecov badges. |
| R3 | Releases should be language-prefixed — `[JavaScript]` / `[Rust]` in the release **title** and `js-` / `rust-` in the release **tag**. | `scripts/create-github-release.mjs` now accepts `--prefix`, uses `${prefix}v${version}` as the tag and `[JavaScript] <version>` / `[Rust] <version>` as the release name. |
| R4 | Compare all CI/CD files with `link-foundation/js-ai-driven-development-pipeline-template` and `link-foundation/rust-ai-driven-development-pipeline-template`; reuse best practices. | See `templates/` folder (snapshots of the two template workflows) and [`root-cause.md`](root-cause.md#mismatch-with-the-upstream-templates). The `always() && !cancelled()` pattern is ported from the templates. |
| R5 | If the same issue is found in templates, report it upstream. | The two templates release a single-language package, so they do not carry the prefix bug; no upstream issue is needed for R3. They _do_ already use `always() && !cancelled()` on `auto-release` (which is exactly the fix we adopt), so they are not affected by R-RC1 either. Nothing to file. |
| R6 | Download all logs and data related to this issue into `docs/case-studies/issue-{id}`. | This folder contains `issue-data.json`, `issue-comments.json`, `releases.json`, and the reviewed template workflows. |
| R7 | Do a deep case-study analysis: timeline, list of requirements, root causes, solution plans, candidate existing libraries. | `timeline.md`, this file, `root-cause.md`, `solutions.md`. |
| R8 | If data is insufficient, add debug output / verbose mode to reach the root cause next iteration. | Not needed — CI logs and GitHub Actions job metadata gave a definitive root cause (see `root-cause.md`). The pipeline already supports `START_VERBOSE=1`, and the release scripts already print the exact commands they execute. |
| R9 | Each filed issue must contain reproducible examples, workarounds, and suggestions. | Not applicable (R5 concluded that no upstream issue is required). The reproductions for _this_ repo are in `README.md` of this folder. |

## Requirements derived from the investigation (not in the original issue)

| # | Requirement | Satisfied by |
|---|-------------|--------------|
| R-RC1 | Fix the silent auto-skip of the `auto-release` job in `.github/workflows/rust.yml`. Without this fix, R3 would still have no effect — the job that would create the prefixed release simply never runs. | Adding `always() && !cancelled()` to the `auto-release` job condition. |
| R-RC2 | Make sure `scripts/format-github-release.mjs` looks up the prefixed tag; otherwise the formatter would fail to find the release immediately after `create-github-release.mjs` just created it with the prefix. | Same `--prefix` plumbing added to `format-github-release.mjs`. |
