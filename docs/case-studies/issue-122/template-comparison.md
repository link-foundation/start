# Template Comparison - Issue #122

The issue requested a full comparison against these templates:

| Source | URL | Files preserved |
| --- | --- | --- |
| JS template | https://github.com/link-foundation/js-ai-driven-development-pipeline-template | `templates/js-release.yml`, `templates/js-links.yml`, `templates/js-create-github-release.mjs` |
| Rust template | https://github.com/link-foundation/rust-ai-driven-development-pipeline-template | `templates/rust-release.yml`, `templates/rust-create-github-release.rs`, `templates/rust-publish-crate.rs` |
| Python template | https://github.com/link-foundation/python-ai-driven-development-pipeline-template | `templates/python-release.yml`, `templates/python-create-github-release.py` |
| C# template | https://github.com/link-foundation/csharp-ai-driven-development-pipeline-template | `templates/csharp-release.yml`, `templates/csharp-create-github-release.mjs` |

The exact reviewed file list is preserved in `templates/reviewed-template-files.txt`.

## Rust template

Relevant findings:

- Has a crate publish step before GitHub release.
- Has a dedicated publish helper.
- Has a release helper that checks process exit status.
- Handles existing releases as an explicit skip rather than a false success.

Impact on this PR:

- Add a crates.io publish step to `.github/workflows/rust.yml`.
- Gate GitHub Release creation on successful crates.io publish.
- Make release creation idempotent and checked.

No upstream Rust template issue was needed for the failures in issue #122.

## JS template

Relevant findings:

- The JS template release helper has the same unchecked `gh api` pattern that
  caused a false success in this repository.
- It can print `Created GitHub release` after a non-zero `gh api` result if the
  command wrapper does not throw.

Impact on this PR:

- Replace this repository's helper with native process execution and explicit
  exit-code handling.
- Add regression tests using a fake `gh` executable.
- Report upstream bug:
  https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/49

## Python template

Relevant findings:

- The Python release helper uses subprocess execution that raises/fails on
  unexpected non-zero command exits.
- It does not have the same unchecked release creation pattern.

Impact on this PR:

- Confirms that the false-positive GitHub release problem is not generic across
  all templates.
- No upstream Python template issue was needed.

## C# template

Relevant findings:

- The C# release helper uses `execSync`, so unexpected non-zero command exits
  fail the script.
- Existing-release handling is less explicit than the Rust template, but it is
  not the same silent success pattern seen in the JS helper.

Impact on this PR:

- Prefer the Rust template's explicit idempotent behavior for release retries.
- No upstream C# template issue was needed for issue #122.

## Start repository gaps closed

| Gap | Template source | Fix |
| --- | --- | --- |
| Rust release did not publish to crates.io | Rust template | Add `scripts/publish-to-crates.mjs` and Rust workflow publish step. |
| GitHub Release could print success after `gh api` failed | Rust template for robust behavior; JS template had the bug | Rewrite helper and add regression tests. |
| Rust package check did not verify publishable package | Cargo publishing docs and Rust release requirements | Use `cargo package --allow-dirty`. |
| JS Docker cleanup test inherited default 5 second timeout | Existing local Docker test pattern | Add explicit Docker-aware timeouts. |

## Follow-up watch items

- The JS template issue should be resolved upstream and then propagated to
  repositories generated from that template.
- The Rust workflow should keep crates.io publish before GitHub Release
  creation, because GitHub Release is an announcement artifact rather than the
  installable Rust package.
