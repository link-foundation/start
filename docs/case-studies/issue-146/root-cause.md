# Root Cause

## JavaScript CI/CD Run 28246415576

The workflow failed because `bun run test` invoked the repository's shared
runner without a per-test timeout override. Bun's default timeout is 5000 ms.

Observed failures:

- `ci-logs/run-28246415576.log:4894`: Windows
  `publish-to-crates script > reports success without a token when the version
  is already published` timed out after 5000 ms.
- `ci-logs/run-28246415576.log:4924`: Windows
  `publish-to-crates script > fails clearly when a missing version needs a
  crates token` timed out after 5000 ms.
- `ci-logs/run-28246415576.log:5848` and `:6839`: Ubuntu
  `CLI isolation output (issue #67) > should display screen session name when
  using screen isolation` timed out after 5000 ms.

Those tests launch child processes or local integration fixtures. They are not
unit-only assertions and can cross 5 seconds on slower CI machines. The
repository already had a shared runner at `scripts/run-js-tests.mjs`, so the
root cause was the missing timeout policy in that runner rather than each
individual test.

The JS pipeline template confirmed the intended policy: its workflow runs
`bun test --timeout 30000`.

## Rust CI/CD Run 28246415639

The Rust workflow reached the push-only `Build Package` job and failed during
dependency download:

- `ci-logs/run-28246415639.log:7476-7490`: Cargo failed to load
  `wasm-bindgen-shared`, could not update the crates.io registry, and ended with
  `[16] Error in the HTTP2 framing layer`.
- `ci-logs/run-28246415639.log:7525`: the same run emitted a Node 20
  deprecation warning for `actions/cache@v4`.

This was a registry transport flake, not a compiler failure. The workflow was
also weaker than the Rust template in two ways:

- It used `actions/cache@v4`, while the Rust template uses `actions/cache@v5`.
- It keyed caches with `hashFiles('rust/Cargo.lock')`, but `rust/Cargo.lock`
  was ignored and not committed, so the cache key could not include the actual
  dependency graph.

The Rust template already had cache v5 and a Cargo.lock guard, so those local
gaps were not template bugs. The remaining shared exposure is Cargo HTTP/2
registry flakiness; that was reported upstream for the Rust template.
