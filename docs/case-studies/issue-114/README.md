# Case Study: Issue #114 - CI/CD release failures after language-prefixed releases

## Summary

Issue #114 reported failed release automation on May 2, 2026 and asked for a
full CI/CD repair so the next JavaScript and Rust package releases can publish.
The requested release shape is explicit:

- JavaScript GitHub Releases use `js-v<version>` tags and `[JavaScript] <version>` titles.
- Rust GitHub Releases use `rust-v<version>` tags and `[Rust] <version>` titles.
- Both release bodies include an exact package-version badge.
- The investigation data, logs, template comparison, root causes, and solution
  analysis are kept in this folder.

## Contents

- [requirements.md](requirements.md) - requirements extracted from the issue and investigation.
- [timeline.md](timeline.md) - ordered reconstruction of the failed runs.
- [root-cause.md](root-cause.md) - evidence-backed root causes.
- [solutions.md](solutions.md) - considered fixes and selected implementation.
- [online-research.md](online-research.md) - official documentation reviewed.
- [ci-logs/](ci-logs/) - downloaded GitHub Actions logs as text.
- [templates/](templates/) - upstream template workflow snapshots and file list.
- `issue-data.json`, `issue-comments.json`, `related-prs.json`,
  `ci-run-25246804640.json`, `ci-run-25246804647.json` - raw GitHub API data.

## Reproduction

```bash
# Failed Rust release run from the issue
gh run view 25246804647 --repo link-foundation/start --log \
  > ci-logs/rust-cicd-25246804647.log

# Related JavaScript run from the same main-branch SHA
gh run view 25246804640 --repo link-foundation/start --log \
  > ci-logs/javascript-cicd-25246804640.log

# Show the Rust release failure
nl -ba ci-logs/rust-cicd-25246804647.log | sed -n '7224,7251p'

# Show the JavaScript Windows timeout failures
nl -ba ci-logs/javascript-cicd-25246804640.log | sed -n '4924,4965p'
```

## High-level findings

| Area                | Finding                                                                                                         | Fix                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Rust release        | `version-and-commit.mjs` rejected workflow mode `changelog`.                                                    | Add Rust `changelog` and `manual` modes that bump `Cargo.toml`, collect `rust/changelog.d`, update `rust/CHANGELOG.md`, commit, and push. |
| Rust manual release | Workflow called invalid mode `manual` and ran a root-hardcoded changelog collector first.                       | Let `version-and-commit.mjs --mode manual --working-dir rust` own the whole Rust manual release update.                                   |
| Release notes       | `create-github-release.mjs` read root `CHANGELOG.md` and only matched `## <version>`.                           | Add `--changelog-file` and a shared extractor that supports Changesets and Keep a Changelog headings.                                     |
| Badges              | JS formatter interpolated prefixed tags into npm badge versions; Rust release bodies had no package badge path. | Normalize prefixed tags before badge generation and add optional npm/crates exact-version badges.                                         |
| JS CI               | Windows tests exceeded Node's default 5000 ms per-test timeout while helper timeouts were longer.               | Add explicit per-test timeout headroom to the affected CLI and Docker tests.                                                              |

## See also

- Issue: https://github.com/link-foundation/start/issues/114
- Pull request: https://github.com/link-foundation/start/pull/115
