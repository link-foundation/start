---
'start-command': patch
---

Teach `scripts/create-github-release.mjs` and `scripts/format-github-release.mjs`
to honour the `--prefix` argument that both workflows already pass. JavaScript
releases are now tagged `js-v<version>` with title `[JavaScript] <version>`,
matching the `rust-v<version>` / `[Rust] <version>` convention needed for the
mono-repo. Extracted the tag/title construction into `scripts/release-name.mjs`
with unit tests in `test/release-name.test.mjs`. See `docs/case-studies/issue-108/`
for the full analysis.
