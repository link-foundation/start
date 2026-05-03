# Solutions

## 1. Make `merge-changesets.mjs` work in a monorepo

### Considered

| Option                                                                                                            | Pros                                                                                  | Cons                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Hardcode `js/.changeset` and `'start-command'` in the script.                                                  | Smallest possible diff.                                                               | Hardcodes language layout; the same script is also useful for Rust-style helpers and breaks if the package is ever renamed.                 |
| B. Port the template repo's `js-paths.mjs` and `package-info.mjs` helpers into this repo and rewrite the script. | Mirrors upstream template; consistent multi-language story.                          | Adds two new modules and several call sites unrelated to the bug; large blast radius for a release-blocking fix.                            |
| C. Add a `--working-dir <dir>` flag and read `package.json` for the package name.                                | Mirrors `version-and-commit.mjs --working-dir` and the rest of the JS scripts; small.  | Two parallel patterns (CLI flag here, helper modules upstream) until the helpers are eventually ported.                                     |

### Chosen: C

`scripts/merge-changesets.mjs` now:

- Parses `--working-dir <dir>` (also `--working-dir=<dir>`) and falls back to
  the `WORKING_DIR` env var or `'.'`.
- Reads `name` from `<workingDir>/package.json` and uses
  `<workingDir>/.changeset` for the changeset directory.
- Exports `mergeChangesetsIn(workingDir)` so it is unit-testable.
- Detects direct invocation via
  `process.argv[1]?.endsWith('merge-changesets.mjs')` so the function can be
  imported without running `main()`.

The auto-release job in `.github/workflows/js.yml` now calls:

```yaml
- name: Merge multiple changesets
  if: steps.check_changesets.outputs.has_changesets == 'true' && steps.check_changesets.outputs.changeset_count > 1
  run: node scripts/merge-changesets.mjs --working-dir js
```

This matches the existing pattern used by `scripts/version-and-commit.mjs --working-dir js`.

## 2. Add the npm version badge to JS GitHub Releases

Both JS `create-github-release.mjs` invocations (auto-release and
instant-release) now also pass:

```
--badge-type "npm" --package-name "start-command"
```

This is the same pattern the Rust workflow already uses for crates.io.

## 3. Tests

Added `js/test/merge-changesets.mjs`:

- 0 changesets - returns `{ merged: false }`.
- 1 changeset - returns `{ merged: false }` and leaves the file alone.
- Multiple changesets - merges into one file with the highest bump type.
- `major` wins over `minor` and `patch`.
- Works for any package name (no hardcoded `start-command`/`my-package`).
- Throws when `.changeset/` is missing.

## What we did **not** change

- `scripts/release-name.mjs` - already correct; covered by
  `js/test/release-name.mjs`.
- The Rust workflow - already passes `--badge-type "crates" --package-name "start-command"`.
- `--prefix "js-"` / `--prefix "rust-"` - already wired up in both workflows.
