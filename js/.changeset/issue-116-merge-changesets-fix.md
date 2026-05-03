---
'start-command': patch
---

Fix release pipeline so multi-changeset merges and JS GitHub Releases work end-to-end. The `merge-changesets.mjs` helper now reads the package name from `package.json` and accepts a `--working-dir` flag, fixing the `ENOENT: no such file or directory, scandir '.changeset'` failure on the JS release workflow when more than one changeset is pending. JS GitHub Releases now also include the exact-version npm badge alongside the existing Rust crates badge.
