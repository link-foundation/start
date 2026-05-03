# Case Study: Issue #116 - Fix all CI/CD issues after language-prefixed releases

## Summary

Issue #116 reported that the JavaScript release pipeline was still failing
after the issue-114 fixes shipped. The reported failed run was
[CI run 25263794761](https://github.com/link-foundation/start/actions/runs/25263794761).
The user also asked us to confirm both JavaScript and Rust GitHub Releases
have:

- Language prefixes in both release **tags** (`js-v<version>` / `rust-v<version>`).
- Language prefixes in both release **titles** (`[JavaScript] <version>` /
  `[Rust] <version>`).
- Specific exact-version package badges (npm for JS, crates.io for Rust).

## Contents

- [requirements.md](requirements.md) - requirements extracted from the issue.
- [timeline.md](timeline.md) - ordered reconstruction of events.
- [root-cause.md](root-cause.md) - evidence-backed root cause for the failed run.
- [solutions.md](solutions.md) - considered fixes and selected implementation.
- [ci-logs/](ci-logs/) - relevant downloaded GitHub Actions log excerpts.

## High-level findings

| Area              | Finding                                                                                                                              | Fix                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS release        | `scripts/merge-changesets.mjs` had hardcoded `PACKAGE_NAME = 'my-package'` and `CHANGESET_DIR = '.changeset'` (template placeholders, not the repo paths). | Read `name` from `<workingDir>/package.json` and use `<workingDir>/.changeset`; accept `--working-dir <dir>`.                                                    |
| JS workflow      | `js.yml` invoked `node scripts/merge-changesets.mjs` from the repo root, so it tried to scan `./.changeset` (which does not exist in this monorepo).        | Pass `--working-dir js` to the script in the auto-release job.                                                                                                   |
| JS release notes | Only the Rust `create-github-release.mjs` invocation passed `--badge-type "crates" --package-name`; the JS invocation skipped the badge entirely.           | Pass `--badge-type "npm" --package-name "start-command"` to both JS `create-github-release.mjs` invocations (auto-release and instant-release).                  |
| Tags & titles    | `releaseTag()` and `releaseName()` already produce `js-v<version>` / `[JavaScript] <version>` and `rust-v<version>` / `[Rust] <version>` correctly.        | No code change needed; verified by existing `js/test/release-name.mjs` cases.                                                                                    |

## See also

- Issue: https://github.com/link-foundation/start/issues/116
- Pull request: https://github.com/link-foundation/start/pull/117
- Predecessor issue: https://github.com/link-foundation/start/issues/114
