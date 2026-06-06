# Timeline

- 2026-06-06 23:24 UTC: The reporter captured two command runs. `--isolation
  docker` ran directly, while `--isolated docker` used Docker isolation.
- 2026-06-06 23:26 UTC: Issue #130 was opened with the reproduction and the
  requirement to add the alias and fail on unrecognized options.
- 2026-06-06 23:26 UTC: Draft PR #131 was created from branch
  `issue-130-cefa8a965461`.
- 2026-06-06: Issue data, PR metadata, code search results, recent related PRs,
  and online CLI parser references were collected under
  `docs/case-studies/issue-130`.
- 2026-06-06: Reproducing JavaScript and Rust parser tests were added and
  confirmed to fail before the implementation.
- 2026-06-06: JavaScript and Rust parsers were updated with `--isolation`
  support and unknown wrapper option errors.
- 2026-06-06: Focused JavaScript and Rust parser tests passed locally.
