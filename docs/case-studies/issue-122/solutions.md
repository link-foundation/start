# Solutions - Issue #122

## S1. Stabilize the Windows Docker cleanup test

Change:

- add `DOCKER_TEST_TIMEOUT`,
- add `DOCKER_STATE_WAIT_TIMEOUT`,
- pass the explicit timeout to Docker cleanup tests in
  `js/test/isolation-cleanup.js`.

Why this fix:

- The failing test took about 16 seconds on Windows and timed out at 5 seconds.
- The behavior passed on other runners.
- Docker integration tests already use larger timeouts elsewhere in the JS
  test suite.

## S2. Make GitHub release creation checked and idempotent

Change:

- replace unchecked command-stream execution in `scripts/create-github-release.mjs`
  with native child process execution,
- inspect `gh api` exit status,
- fail the script on unexpected non-zero exit,
- treat `already_exists` / tag validation failure as an idempotent skip with a
  clear `GitHub release already exists` message,
- add regression tests with a fake `gh` executable.

Why this fix:

- GitHub's Create Release endpoint returns `201` on creation and `422` for
  validation failures. A release helper must distinguish those outcomes.
- A release retry should be safe when the release already exists, but it should
  not print a creation success message.

## S3. Publish Rust to crates.io before creating the GitHub Release

Change:

- add `scripts/publish-to-crates.mjs`,
- probe crates.io for the exact package version,
- skip publishing when the version is already present,
- preflight `CARGO_REGISTRY_TOKEN` or `CARGO_TOKEN` only when a publish is
  needed, and enforce the same check inside the publish helper,
- run `cargo publish --allow-dirty --manifest-path rust/Cargo.toml`,
- set GitHub Actions outputs through `$GITHUB_OUTPUT`,
- gate Rust GitHub Release creation and verification on
  `steps.publish_start_command.outputs.published == 'true'`.

Why this fix:

- The issue's Rust complaint is about no crates.io publish. The workflow now
  makes crates.io publish the primary release action and GitHub Release the
  follow-up announcement.
- The publish helper is idempotent, so reruns do not fail just because the
  crate version was already published by an earlier attempt.

## S4. Verify the actual publishable Rust package

Change:

- replace `cargo package --list` in Rust CI with `cargo package --allow-dirty`,
- change `start-command` to depend on published `lino-objects-codec = "0.2.0"`,
- adapt `.lino` read/write code to `LinoValue`.

Why this fix:

- `cargo package --list` did not catch the path dependency problem.
- `cargo publish` resolves registry dependencies. CI should compile the same
  package shape users receive after publish.

## S5. Add release metadata

Change:

- add JS changeset `js/.changeset/fix-ci-cd-release.md`,
- add Rust changelog fragment `rust/changelog.d/123.md`,
- update `rust/README.md` to describe crates.io release behavior.

## Alternatives considered

### Keep local path dependency with a version

Cargo supports dependencies with both `path` and `version`, using the local path
during development and the registry version when publishing. That was not
enough here because the local crate version was `0.1.0` while crates.io had
`0.2.0`, and the public API changed.

### Publish `lino-objects-codec` from this workflow first

This was considered, but the crate name already has `0.2.0` on crates.io and
the current `start-command` package can compile against that registry version.
Publishing a local dependency from the same workflow would expand release scope
and require versioning a second crate that issue #122 did not ask to release.

### Create GitHub Release before crates.io publish

Rejected. That ordering can announce a release that users cannot install from
crates.io. The workflow now publishes first and creates the GitHub Release only
after the publish step reports success.

## Verification checklist

Focused local verification:

- `bash scripts/check-mjs-syntax.sh`
- `cd js && bun install`
- `cd js && bun run lint`
- `cd js && bun run format:check`
- `cd js && bun run test`
- `cd js && bun ../scripts/run-js-tests.mjs test/create-github-release.mjs`
- `cd js && bun ../scripts/run-js-tests.mjs test/publish-to-crates.mjs`
- `cd js && bun ../scripts/run-js-tests.mjs test/isolation-cleanup.js`
- `cd rust && cargo fmt --all -- --check`
- `cd rust && cargo check --all-targets`
- `cd rust && cargo clippy --all-targets --all-features`
- `cd rust && cargo test --all-features --verbose`
- `cd rust && cargo package --allow-dirty`
- `node scripts/check-file-size.mjs`

Full CI verification:

- push only branch `issue-122-9e4e6b1efac6`,
- update PR #123 title/body,
- mark PR ready,
- inspect latest CI runs for the pushed head SHA,
- download failed logs if any new CI run fails.
