# Requirements - Issue #122

## R1. Find the root cause of the JavaScript CI failure

The issue links to JavaScript CI/CD run `25286510018`, job `74131657798`, and
asks to find the root cause and fix it "once and for all".

Status: addressed.

Evidence: `ci-logs/javascript-cicd-25286510018.log` line 6574 shows the failed
test name, and line 6575 shows Bun timing it out after 5000 ms.

## R2. Fix Rust release publishing

The issue links to Rust CI/CD run `25286510029`, job `74131749322`, and says
there was no actual publish of a new Rust release to crates.io and no new Rust
GitHub release version.

Status: addressed.

Evidence: `ci-logs/rust-cicd-25286510029.log` lines 7615-7617 show the workflow
detected that `start-command` was not already published and should release.
Lines 7718-7719 show GitHub rejected the release creation with HTTP 422
`already_exists`, but the helper still printed a created-release success line.

## R3. Compare CI/CD templates

The issue asks to compare all relevant workflow and CI/CD script files against:

- https://github.com/link-foundation/js-ai-driven-development-pipeline-template
- https://github.com/link-foundation/rust-ai-driven-development-pipeline-template
- https://github.com/link-foundation/python-ai-driven-development-pipeline-template
- https://github.com/link-foundation/csharp-ai-driven-development-pipeline-template

Status: addressed.

The comparison is recorded in `template-comparison.md`, and the reviewed
template files are preserved under `templates/`.

## R4. Report matching template bugs upstream

The issue asks to report issues in template repositories when the same issue is
found there.

Status: addressed.

The JS template has the same unchecked `gh api` release-helper pattern. An
upstream issue was created:

- https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/49

No matching Rust publish bug was found in the Rust template. It already has a
crate publish step and a Rust release helper that checks process exit status.

## R5. Preserve logs and data in the repository

The issue asks to download logs and data related to the issue into
`docs/case-studies/issue-{id}`.

Status: addressed.

This folder contains:

- raw workflow logs for both cited runs,
- workflow metadata for both cited runs,
- recent run history,
- issue metadata and comments,
- PR metadata,
- relevant template workflow and helper snapshots.

## R6. Reconstruct timeline and root causes

Status: addressed.

See `timeline.md` and `root-cause.md`.

## R7. Research external facts and existing components

Status: addressed.

See `online-research.md`. The solution uses existing platform components:

- `cargo publish` for crates.io release,
- GitHub REST Releases API through `gh api`,
- GitHub Actions step outputs through `$GITHUB_OUTPUT`,
- Cargo's normal registry dependency resolution for publishable crates.

## R8. Add tests that reproduce the broken behavior

Status: addressed.

Regression tests were added for:

- existing GitHub release should be an idempotent skip and should not print
  `Created GitHub release`,
- unexpected `gh api` failure should fail the helper,
- already-published crates.io version should succeed without a token,
- missing crates.io token should fail clearly,
- missing crates.io version should call `cargo publish` and set outputs.

The Windows Docker timing problem is covered by updating the exact failing
Docker cleanup tests to use explicit Docker-aware test timeouts.
