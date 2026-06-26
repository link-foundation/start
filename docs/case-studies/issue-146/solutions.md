# Solutions

## Implemented Changes

### JavaScript Test Timeout Hardening

- Added `applyDefaultTimeout()` and `hasExplicitTimeout()` to
  `scripts/run-js-tests.mjs`.
- The shared runner now prepends `--timeout 30000` unless the caller already
  supplied `--timeout`, `--timeout=...`, or Bun's `-t` timeout flag.
- The runner no longer executes tests as a side effect when imported, allowing
  focused unit coverage around its argument policy.
- Added `js/test/run-js-tests.mjs` to cover the default and explicit timeout
  cases.
- Added `js/.changeset/ci-test-timeouts.md` because `.mjs` runner changes are
  treated as JS code changes by this repository's PR gate.

### Rust Workflow Hardening

- Added workflow-level Cargo network settings in `.github/workflows/rust.yml`:
  - `CARGO_NET_RETRY: '10'`
  - `CARGO_HTTP_MULTIPLEXING: 'false'`
- Upgraded all Rust workflow cache steps from `actions/cache@v4` to
  `actions/cache@v5`.
- Generated and committed `rust/Cargo.lock` so existing
  `hashFiles('rust/Cargo.lock')` cache keys are meaningful.
- Updated `.gitignore` to keep the generic `Cargo.lock` ignore rule while
  explicitly allowing `rust/Cargo.lock`.

## Reproducer

The focused timeout policy test failed before the runner fix and passed after
the runner fix:

- Before: `data/reproducer-run-js-tests-before.log`
- After: `data/reproducer-run-js-tests-after.log`

The Rust registry failure is a network flake from GitHub-hosted CI and was not
reliably reproducible locally. The fix is based on the downloaded run log, the
Rust template comparison, and Cargo's documented environment variables.

## Verification

All verification logs are preserved in `data/`.

JavaScript:

- `cd js && bun install`
- `cd js && bun ../scripts/run-js-tests.mjs test/run-js-tests.mjs test/publish-to-crates.mjs`
  - 7 passed, 0 failed.
- `cd js && bun ../scripts/run-js-tests.mjs test/cli.js`
  - 8 passed, 0 failed. The screen regression passed locally; tmux was skipped
    because it is not installed in this environment.
- `cd js && bun run test`
  - 689 passed, 0 failed.
- `cd js && bun run test --coverage --coverage-reporter=text`
  - 689 passed, 0 failed.
  - Line coverage: 86.33%, above the workflow's 45% threshold.
- `cd js && bun run lint`
- `cd js && bun run format:check`

Rust:

- `cd rust && cargo fmt --all -- --check`
- `cd rust && cargo clippy --all-targets --all-features`
- `cd rust && cargo test --all-features --verbose`
  - 12 unit tests and 6 doc tests passed.
- `cd rust && cargo test --doc --verbose`
  - 6 doc tests passed.
- `cd rust && cargo build --release --verbose`
- `cd rust && cargo package --allow-dirty`
  - Packaged and verified `start-command v0.17.1`.

Shared guards:

- `bash scripts/check-mjs-syntax.sh`
  - 31 `.mjs` files passed syntax check.
- `node scripts/check-file-size.mjs`
  - All checked JavaScript and Rust files are within the 1000-line limit.
- `GITHUB_EVENT_NAME=pull_request ... node scripts/detect-code-changes.mjs`
  - Detected `any-js-code-changed=true`, `workflow-changed=true`, and
    `any-rust-code-changed=false` for this PR diff.
- `GITHUB_BASE_SHA=... GITHUB_HEAD_SHA=HEAD node scripts/validate-changeset.mjs`
  - Found and validated exactly one changed JS changeset:
    `js/.changeset/ci-test-timeouts.md`.
- `git diff --cached --check -- . ':(exclude)docs/case-studies/issue-146/**/*.log'`
  - No whitespace errors outside preserved raw log artifacts.
