# Solutions considered

## RC1 and RC2 - Rust versioning modes

| Option                                                                       | Verdict                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A. Extend `version-and-commit.mjs` with Rust `changelog` and `manual` modes. | Chosen. It keeps one release entry point for both workflows while making the package type explicit from the mode.               |
| B. Port the Rust template's Rust scripts into this repository.               | Rejected for this PR. It would add a second script stack and a larger migration than needed to fix the current release failure. |
| C. Inline Cargo versioning directly in `.github/workflows/rust.yml`.         | Rejected. It would make release behavior harder to test and reuse.                                                              |

The selected fix makes the script:

- read and bump `rust/Cargo.toml`,
- collect `rust/changelog.d/*.md`,
- write `rust/CHANGELOG.md`,
- remove processed fragments,
- stage only Rust release files,
- commit and push to `main` during the release job.

## RC3 - Package changelog extraction

| Option                                                                                           | Verdict                                                                                 |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| A. Add `--changelog-file` to `create-github-release.mjs` and a shared changelog-entry extractor. | Chosen. It is minimal and keeps release notes package-specific.                         |
| B. Duplicate release creation scripts for JS and Rust.                                           | Rejected. The tag/title/badge behavior should stay shared.                              |
| C. Move all changelogs back to the root.                                                         | Rejected. The issue asks for clearly marked language releases in a multi-language repo. |

## RC4 - Exact-version badges

| Option                                                                                                              | Verdict                                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A. Add shared badge helpers that normalize `js-v` / `rust-v` tags and escape shields.io static badge path segments. | Chosen. It matches the JavaScript template's helper pattern and covers both package managers. |
| B. Use dynamic package-manager badges only.                                                                         | Rejected. The issue asks for badges for specific versions in GitHub Releases.                 |
| C. Hard-code badge markdown in workflow YAML.                                                                       | Rejected. That would duplicate escaping and prefix normalization.                             |

The JavaScript workflow still lets `format-github-release.mjs` add the npm badge
after release creation so it can also add the related PR link. The Rust workflow
adds the crates.io badge during release creation because it has no separate
formatter step.

## RC5 - Windows test timeouts

| Option                                                                         | Verdict                                                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| A. Add explicit per-test timeout values aligned with existing helper timeouts. | Chosen. It fixes the CI failure without changing product code or hiding real hangs. |
| B. Increase global test timeout for all files.                                 | Rejected. The failure is limited to two slow skip/startup paths.                    |
| C. Remove the Docker availability checks on Windows.                           | Rejected. The checks provide useful coverage and should skip cleanly.               |

## Verification plan

1. Unit test release tag/title helpers, exact badge generation, and changelog extraction.
2. Run the formerly failing JavaScript test files locally.
3. Run JS lint and formatting checks.
4. Run Rust formatting, clippy, and tests.
5. Review the PR diff to ensure release automation changes are scoped to the issue.
