# Root cause

## Primary failure: `ENOENT scandir '.changeset'` in the JS release job

[CI run 25263794761](https://github.com/link-foundation/start/actions/runs/25263794761)
fails at the "Merge multiple changesets" step:

```
node:fs:1503
  return binding.readdir(...);
                 ^

Error: ENOENT: no such file or directory, scandir '.changeset'
    at Object.readdirSync (node:fs:1503:26)
    at file:///home/runner/work/start/start/scripts/merge-changesets.mjs:106:23
```

(See `ci-logs/javascript-cicd-25263794761.txt` line 312.)

The committed `scripts/merge-changesets.mjs` had two template placeholder
values that were never adapted to this repo's monorepo layout:

```js
const PACKAGE_NAME = 'my-package';
const CHANGESET_DIR = '.changeset';
```

The workflow runs the script from the repository root, so `'.changeset'`
resolves to `/home/runner/work/start/start/.changeset` - a directory that
does not exist. Changesets in this repo live under `js/.changeset/`. The
hardcoded `'my-package'` would also have prevented the regex from matching
`'start-command': minor` even if the directory had been read.

## Secondary gap: missing npm badge on JS GitHub Releases

`scripts/create-github-release.mjs` accepts `--badge-type` and `--package-name`
to append an exact-version package badge to the release body
(`scripts/release-name.mjs::packageVersionBadge`). The Rust workflow already
passes them:

```yaml
- name: Create GitHub Release
  run: |
    node scripts/create-github-release.mjs \
      --release-version "${{ steps.current_version.outputs.version }}" \
      --repository "${{ github.repository }}" \
      --prefix "rust-" \
      --changelog-file "rust/CHANGELOG.md" \
      --badge-type "crates" \
      --package-name "start-command"
```

The JS workflow did not - so JS GitHub Releases were missing the npm version
badge that the issue explicitly asks for.

## Already-correct pieces

- `releaseTag()` and `releaseName()` in `scripts/release-name.mjs` already
  produce the expected `js-v<version>` / `rust-v<version>` tags and the
  `[JavaScript] <version>` / `[Rust] <version>` titles. Existing tests cover
  this in `js/test/release-name.mjs`.
- The `--prefix "js-"` / `--prefix "rust-"` flags are already passed to both
  `create-github-release.mjs` and `format-github-release.mjs`.
