# Post-merge backfill of release notes

The CI fixes in PR #119 ensure every *new* release ships with a
version-specific badge and a populated body. They do not retroactively
edit older releases. Run the recipe below once after this PR is merged
to bring the historical releases into the same shape.

## Audit (taken 2026-05-03)

```bash
gh release list --repo link-foundation/start --limit 50 \
  --json tagName,name --jq '.[] | "\(.tagName)\t\(.name)"'
```

| Tag             | Release exists? | Body has `<pkg>-<version>` badge | Action          |
| --------------- | --------------- | -------------------------------- | --------------- |
| `js-v0.27.0`    | yes             | yes                              | none            |
| `js-v0.26.0`    | yes             | no                               | back-fill       |
| `js-v0.25.5`    | yes             | no                               | back-fill       |
| `rust-v0.14.1`  | yes             | yes                              | none            |
| `rust-v0.14.0`  | **no release**  | n/a (tag never pushed either)    | none — see note |
| `rust-v0.13.0`  | **no release**  | n/a (tag never pushed either)    | none — see note |
| `v0.25.4` ↓     | yes             | n/a (pre-prefix releases)        | leave as-is     |

> **Note on `rust-v0.13.0` / `rust-v0.14.0`** — neither a git tag nor a
> GitHub release exists for these versions. Earlier drafts of this case
> study assumed they did because `gh release view <tag> --json body`
> prints the literal `release not found` (12 chars) and a previous
> automated check mistook that for an "empty body". The publisher
> simply skipped these versions before the badge work in PR #115; no
> back-fill is possible because there is no release object to PATCH.

## Recipe

```bash
# JS 0.25.5 and 0.26.0 — bodies exist, but lack the version badge
GH_TOKEN="$(gh auth token)" node scripts/backfill-release-notes.mjs \
  --repository link-foundation/start \
  --tag js-v0.25.5 \
  --changelog-file js/CHANGELOG.md \
  --badge-type npm \
  --package-name start-command

GH_TOKEN="$(gh auth token)" node scripts/backfill-release-notes.mjs \
  --repository link-foundation/start \
  --tag js-v0.26.0 \
  --changelog-file js/CHANGELOG.md \
  --badge-type npm \
  --package-name start-command
```

Add `--dry-run` to any invocation to preview the body without PATCHing
the release.

## Verification

After running the recipe, re-run the badge check:

```bash
for tag in js-v0.25.5 js-v0.26.0; do
  node scripts/verify-release-badge.mjs \
    --repository link-foundation/start \
    --tag "$tag" \
    --badge-type npm \
    --package-name start-command \
    --release-version "${tag#js-v}"
done
```

Both invocations should print `✅ Release <tag> contains the expected
npm badge.`
