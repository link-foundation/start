# Requirements — Issue #120

Each row below quotes a phrase from issue #120 and points at the artifact in
this PR that addresses it.

| # | Requirement (from issue #120) | Status | Evidence |
|---|-------------------------------|--------|----------|
| 1 | "We need to fix CI/CD fully" — the two cited failing runs must turn green. | Done | `scripts/preflight-credentials.mjs` no longer calls `gh api user`; both release jobs reach their real publish steps. See `solutions.md#fix`. |
| 2 | "Previously CI/CD was working, we don't use tokens for NPM package release, we use modern trusted publishing." | Honoured | `release` job in `js.yml` keeps `permissions: id-token: write` and the `setup-npm.mjs` OIDC flow; only the validation method for the `gh` token changed. |
| 3 | "Also version bump was working with GitHub Actions default token previously." | Honoured | `release` and `auto-release` continue to use `secrets.GITHUB_TOKEN` for git push and `gh release create`. The fix removes the *invalid* validation that was rejecting that exact token. |
| 4 | "See also best practices from working CI/CD as `link-assistant/hive-mind`." | Done | `comparison-with-templates.md` enumerates every workflow-level best practice we already follow and the two we adopted in this PR (force Node 24 env, structured permissions per release job). |
| 5 | "Use all the best practices from CI/CD templates (check full file tree to compare for all GitHub workflow and CI/CD scripts file)" | Done | `comparison-with-templates.md` covers the JS, Rust, Python, and C# templates. `python` and `csharp` are out of scope for this repo's *runtime* but their workflow shape is checked. |
| 6 | "if the same issue is found in template report issue also in templates" | Done (none required) | The `gh api user` mistake exists in **this** repo's preflight script, not in any of the four templates — the templates do not have a preflight script. No template-side issues filed. The two minor template improvements (`SUMMARY` heading + line-limit doc note) were filed as comments on existing template issues; see `comparison-with-templates.md` for links. |
| 7 | "We should compare all files, so we don't have more CI/CD errors in the future and reuse all the best practices" | Done | Side-by-side diff in `comparison-with-templates.md`. |
| 8 | "We need to download all logs and data related about the issue to this repository, make sure we compile that data to `./docs/case-studies/issue-{id}` folder" | Done | `docs/case-studies/issue-120/{ci-logs,recent-runs.json,issue-data.json,…}`. |
| 9 | "use it to do deep case study analysis (also make sure to search online for additional facts and data)" | Done | `root-cause.md` quotes the GitHub Docs section on automatic token auth (the canonical online source) and links to it. |
| 10 | "reconstruct timeline/sequence of events" | Done | `timeline.md`. |
| 11 | "list of each and all requirements from the issue" | Done | This file. |
| 12 | "find root causes of the each problem" | Done | `root-cause.md`, sections RC-1, RC-2, RC-3. |
| 13 | "propose possible solutions and solution plans for each requirement" | Done | `solutions.md` documents the chosen fix and the two alternatives that were rejected. |
| 14 | "we should also check known existing components/libraries, that solve similar problem or can help in solutions" | Done | `solutions.md#prior-art`. |
| 15 | "If there is not enough data to find actual root cause, add debug output and verbose mode if not present" | Done (already had it) | `scripts/debug-print.mjs` (`DEBUG=1`) is wired into `preflight-credentials.mjs`. We extended the `dumpEnv` block so the diagnostic also reports the *kind* of token we infer (PAT vs installation), which would have caught this regression on the first PR run if turned on. |
| 16 | "If issue related to any other repository/project, where we can report issues on GitHub, please do so. Each issue must contain reproducible examples, workarounds and suggestions for fix the issue in code." | Done (none needed) | The bug is local. The pipeline templates are clean. No external bug report needed. |
| 17 | "Please plan and execute everything in a single pull request" | Done | All work is on PR #121. |

## Implicit follow-ups discovered while doing the work

| ID | Need | Where |
|---|---|---|
| F-1 | A way to **dry-run** the release job on PRs so the next regression in the preflight (or any release-only step) is caught before merge. | `solutions.md#future-work-f-1`. Recorded as future work; not implemented in this PR because it requires test-only secrets and would expand scope. |
| F-2 | The existing `verify-release-badge.mjs` post-condition is good. The same idea — *check the result, not just the input* — should be applied to the version-bump step (assert the new version is one ahead of the registry's latest). | `solutions.md#future-work-f-2`. |
