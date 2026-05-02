# Timeline

## 2026-05-02 07:24 UTC

Two workflows ran on `main` at SHA `19784b188d6ad6eff654623f2ba698906dde0d13`:

- JavaScript CI/CD run `25246804640` failed.
- Rust CI/CD run `25246804647` failed.

Both logs were downloaded and preserved in [ci-logs/](ci-logs/).

## 2026-05-02 07:25 UTC - JavaScript Windows failure

The JavaScript run failed in `Test (Bun on windows-latest)`.

Evidence from `ci-logs/javascript-cicd-25246804640.txt`:

- Lines 4924-4948: `test\cli.js` timed out at 5031 ms in
  `CLI version flag > should display version with --version`, then the spawned
  process was killed with `SIGTERM`.
- Lines 4961-4965: `test\docker-autoremove.js` timed out at 6406 ms while
  discovering that Docker was not available.
- Lines 5703-5713: the final summary reports 594 passing tests and the same
  two timeout failures.

## 2026-05-02 07:27 UTC - Rust auto-release failure

The Rust run reached `Auto Release` and found 20 Rust changelog fragments.

Evidence from `ci-logs/rust-cicd-25246804647.txt`:

- Lines 7175-7199: `get-bump-type.mjs` found 20 fragments and selected a patch bump.
- Lines 7224-7228: the workflow called
  `node scripts/version-and-commit.mjs --bump-type "patch" --working-dir rust --mode changelog`.
- Lines 7236-7251: yargs rejected `changelog` because the script only accepted
  `changeset` and `instant`.

## Investigation on branch `issue-114-8181f01863b9`

The issue body, issue comments, PR state, recent branch CI runs, main-branch CI
runs, and upstream template files were reviewed. No recent CI runs existed on
the prepared branch before this fix.

The existing PR was draft-only with placeholder content. It is updated by this
work with a concrete title, description, tests, and case-study links.

## 2026-05-02 10:46 UTC - PR changeset validation failure

After commit `1df494042de25f19c7fa25e5be4bd28fa93c0d72` was pushed to
`issue-114-8181f01863b9`, JavaScript CI/CD run `25250182498` failed in
`Check for Changesets`.

Evidence from `ci-logs/javascript-cicd-25250182498.txt`:

- Line 298: `detect-code-changes.mjs` saw this PR's new
  `js/.changeset/issue-114-cicd-release-fixes.md`.
- Lines 950-954: `validate-changeset.mjs` counted both
  `issue-112-detached-controls.md` from `origin/main` and the new issue #114
  changeset, then failed with "Multiple changesets found (2)".

The validator was updated to use the PR base/head diff when GitHub Actions
provides `GITHUB_BASE_SHA` and `GITHUB_HEAD_SHA`, while preserving whole-folder
validation for local runs without those environment variables.
