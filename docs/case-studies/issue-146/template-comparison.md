# Template Comparison

Templates inspected:

- https://github.com/link-foundation/js-ai-driven-development-pipeline-template
- https://github.com/link-foundation/rust-ai-driven-development-pipeline-template
- https://github.com/link-foundation/python-ai-driven-development-pipeline-template
- https://github.com/link-foundation/csharp-ai-driven-development-pipeline-template

Template workflow snapshots are preserved in `templates/`. File inventories are
preserved in `data/*-template-file-tree.txt`.

## JavaScript Template

Relevant finding:

- `templates/js/release.yml:312` runs `bun test --timeout 30000`.

Local repo before this PR:

- The workflow ran `bun run test`.
- `js/package.json` resolved that command to `bun ../scripts/run-js-tests.mjs`.
- The shared runner did not add any timeout, so Bun used its 5000 ms default.

Decision:

- Keep the local shared runner and add the template's timeout policy there.
  This covers normal tests and coverage tests without duplicating flags in every
  workflow step.

No JS template issue was filed because the template already has the timeout
hardening that this repo lacked.

## Rust Template

Relevant findings:

- `templates/rust/release.yml:125-152` includes a Cargo.lock guard for binary
  crates.
- `templates/rust/release.yml:189`, `:240`, `:281`, and `:321` use
  `actions/cache@v5`.
- Cache keys use committed lockfiles via `hashFiles('**/Cargo.lock')`.

Local repo before this PR:

- The workflow used `actions/cache@v4`, producing Node 20 deprecation warnings
  when forced onto Node 24.
- The workflow keyed caches with `hashFiles('rust/Cargo.lock')`, but
  `Cargo.lock` was globally ignored and absent from git.
- The workflow did not set Cargo network retry or HTTP multiplexing controls.

Decision:

- Adopt cache v5 and commit `rust/Cargo.lock`.
- Add Cargo network hardening for the observed HTTP/2 registry failure.

Template follow-up:

- Filed https://github.com/link-foundation/rust-ai-driven-development-pipeline-template/issues/83
  for the shared Cargo HTTP/2 registry flake risk.

## Python Template

The Python template was inspected for general CI/CD patterns. No issue from the
linked failures applied directly because this repository's failures were in Bun
test execution and Cargo registry access.

## C# Template

The C# template was inspected for general CI/CD patterns. No issue from the
linked failures applied directly because this repository's failures were in Bun
test execution and Cargo registry access.
