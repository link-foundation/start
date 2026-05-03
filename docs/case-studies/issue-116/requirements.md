# Requirements

Sourced from issue #116 plus the linked failed CI run.

## Functional

1. The JavaScript release pipeline must complete successfully when one or more
   pending changesets exist in `js/.changeset/` on `main`.
2. New JavaScript and Rust package versions must be publishable from CI.
3. JavaScript GitHub Releases must use:
   - Tag: `js-v<version>` (e.g. `js-v0.27.0`)
   - Title: `[JavaScript] <version>` (e.g. `[JavaScript] 0.27.0`)
   - Body: changelog entry plus an exact-version npm badge.
4. Rust GitHub Releases must use:
   - Tag: `rust-v<version>` (e.g. `rust-v0.14.2`)
   - Title: `[Rust] <version>` (e.g. `[Rust] 0.14.2`)
   - Body: changelog entry plus an exact-version crates.io badge.

## Non-functional

1. Workflow scripts must work in a multi-language monorepo where the JS package
   lives under `js/` and the Rust package lives under `rust/`.
2. Helpers must read configuration (package name, changeset directory) from
   the repo, not from hardcoded template placeholder values.
3. The fix must be covered by automated tests so it does not regress.
4. The investigation evidence (logs, root cause, solution selection) must be
   committed under `docs/case-studies/issue-116/`.

## Out of scope

- Rerunning the previously fixed Rust mode failures from issue #114.
- Refactoring `merge-changesets.mjs` to use the template repo's helper modules
  (`js-paths.mjs`, `package-info.mjs`) - those modules don't exist in this
  repo and porting them would expand the change beyond the bug fix.
