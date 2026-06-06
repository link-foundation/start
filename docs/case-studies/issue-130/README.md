# Issue 130 Case Study: `--isolation` Alias

## Summary

Issue #130 reports that `$ --isolation docker -- echo 'hi'` runs directly on
the host instead of using Docker isolation, while `$ --isolated docker -- echo
'hi'` works as expected.

The fix adds `--isolation` as a first-class alias for `--isolated` in both the
JavaScript and Rust parsers. It also changes unknown dash-prefixed wrapper
options from silent fallthrough to immediate parser errors, so a mistyped
wrapper option cannot accidentally run the target command outside the requested
environment.

## Evidence Collected

- Issue data: [issue-data.json](issue-data.json)
- Issue comments: [issue-comments.json](issue-comments.json)
- Prepared PR metadata: [pr-131.json](pr-131.json)
- Repository search for existing `--isolation` usage:
  [data/code-search-isolation.json](data/code-search-isolation.json)
- Repository search for existing `--isolated` usage:
  [data/code-search-isolated.json](data/code-search-isolated.json)
- Recent isolation-related PRs:
  [data/recent-isolation-prs.json](data/recent-isolation-prs.json)

## Implemented Plan

1. Add failing parser tests for `--isolation <env>` and `--isolation=<env>`.
2. Add failing parser tests for unknown wrapper options before and without the
   explicit `--` separator.
3. Update JavaScript and Rust parsers to recognize `--isolation` wherever
   `--isolated` is accepted.
4. Reject unknown dash-prefixed wrapper options before they can fall through to
   direct command execution.
5. Update help text, README option docs, and release metadata.

## Outcome

`--isolation docker` now produces the same parsed isolation request as
`--isolated docker`. Unknown wrapper options such as `--isolatin docker` now
fail fast with `Unknown wrapper option: --isolatin`; users can still run a
command whose first token starts with `-` by using the explicit command
separator: `$ -- --some-command`.
