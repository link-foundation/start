# Contributing

Start with JavaScript behavior and a minimal reproducing test. Apply the corresponding implementation or behavioral-test change to Rust and update `parity/features.json`. The checker inventories all `js/src` and `rust/src` files and rejects a feature changed on only one side. Shared golden contracts cover CLI parsing, Docker arguments, status output and execution records. Equal test counts do not establish parity.

## Local checks

```sh
cd js
bun install
bun run check
bun run test
```

Run JavaScript checks locally by default. For focused parity checks from the repository root:

```sh
bun scripts/check-javascript-first.mjs
node scripts/check-feature-parity.mjs --manifest-only
bun test ./js/test/shared-golden.js ./js/test/javascript-first-ci.js
node scripts/setup-translation.mjs
bun scripts/generate-rust.mjs --check
```

`PARITY_BASE_SHA` selects the comparison commit for the feature-change checker; otherwise it compares with the merge base of `origin/main`. `PARITY_VERBOSE=1` prints changed files and translation setup details. Changes to one language must include corresponding implementation or behavioral-test evidence in the other; changing only a manifest does not satisfy that evidence.

## Generation and manual adapters

`parity/translation.json` pins the upstream repository commit and executable JS-to-Rust mappings. `node scripts/setup-translation.mjs` fetches that exact commit and installs its locked production dependencies into ignored `.translation/`. `bun scripts/generate-rust.mjs` invokes the upstream translator; `--check` genuinely regenerates and compares every byte. It rejects carried or unsupported items. Rust CI executes the generated policy against the same values as JavaScript.

The native process/filesystem adapters still need manual Rust because the translator does not support their actual constructs. The complete per-file inventory, source construct evidence and upstream issues are in the manifest and [translation analysis](docs/case-studies/issue-197/translation.md). Keep manual additions narrow and remove entries when a supported generated mapping replaces them.

## Bounded Rust diagnosis

Only start a local Rust build when JavaScript evidence cannot resolve the question. On Linux use the wrapper, which admits one build at a time, shares `.cargo-target`, disables incremental compilation, caps compilation at two jobs, imposes a per-process virtual-memory limit and prunes the target before/after a build that exceeds its disk budget:

```sh
START_CARGO_MAX_GIB=4 START_CARGO_MEMORY_GIB=2 node scripts/bounded-cargo.mjs test --test shared_golden
```

The default memory limit is 2 GiB **per process**, not a combined cgroup budget; two compile jobs can use more in total. Use a cgroup/container memory limit for a hard aggregate limit. On systems without Linux `prlimit`, supply an OS/container memory limit before using the wrapper. The disk budget is a pruning threshold, not a filesystem quota; use a finite filesystem quota if a hard instantaneous disk limit is required. Dev/test profiles emit no debug symbols and disable incremental artifacts. CI caches registry/git downloads only, with exact lockfile/profile keys and no stale target fallback.

## CI ownership and release review

For multi-agent work, designate one CI/CD agent to own all pushes. Drafting agents never push. The owner waits for all drafts, runs local JavaScript checks, verifies the branch, and makes one push. It waits for **all** jobs from that run to finish, saves every failed/cancelled log under `ci-logs/`, reports exact errors, coordinates a bulk fix and makes one next push. It never pushes while an older run on those branch commits is queued or in progress.

All Rust jobs, including audits and Rust CodeQL, run only through the relative same-commit reusable Rust workflow after `JavaScript Stage` succeeds. Required jobs cannot pass by being skipped or cancelled. Optional release/check jobs may be skipped, but failures or cancellations still fail the stage. Rust has one per-branch non-cancelling entry group. Main checks and all main writers never cancel one another; writers remain serialized across languages.

Before marking a draft ready, review the complete diff against the issue, check current main ancestry, a clean worktree, release fragments, both required stage checks and every other CI check. Preserve commit history and document reproduction, tests and material limits in the pull request.
