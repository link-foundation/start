# Comparison with link-foundation pipeline templates

Templates inspected (cloned to `/tmp/ai-pipeline-templates/`):

- [`js-ai-driven-development-pipeline-template`](https://github.com/link-foundation/js-ai-driven-development-pipeline-template)
- [`rust-ai-driven-development-pipeline-template`](https://github.com/link-foundation/rust-ai-driven-development-pipeline-template)
- [`python-ai-driven-development-pipeline-template`](https://github.com/link-foundation/python-ai-driven-development-pipeline-template)
- [`csharp-ai-driven-development-pipeline-template`](https://github.com/link-foundation/csharp-ai-driven-development-pipeline-template)

## JavaScript workflow gaps

| Feature in template | This repo | PR #119 |
| --- | --- | --- |
| `actions/checkout@v6` | `@v4` | upgraded |
| `actions/setup-node@v6` | `@v4` | upgraded |
| `node-version: '24.x'` | `'20.x'` (deprecated; CI emits warnings) | bumped |
| `timeout-minutes` on every job | none | added (5/10/30 per job) |
| `simulate-fresh-merge.sh` (validates the *actual* merge result) | absent | ported into `scripts/` |
| `check-mjs-syntax.sh` (~7 s syntax pre-check) | absent | ported |
| `check-release-needed.mjs` (self-healing — checks npm, not git tags) | absent | ported and adapted for `--js-root js` |
| `secretlint` step | absent | not in this PR (tracked as follow-up — needs `.secretlintrc.json`) |
| `jscpd` (code duplication) | absent | not in this PR (tracked as follow-up — needs threshold tuning) |
| Multi-runtime test matrix (Node + Bun + Deno) | Bun-only | not in this PR (large change; tracked as follow-up) |
| `if: !cancelled()` on release / test jobs | mix of `always()` | normalised |
| Concurrency: `cancel-in-progress` only on `main` | unconditional cancel | matched |

## Rust workflow gaps

| Feature in template | This repo | PR #119 |
| --- | --- | --- |
| `check-release-needed.rs` (queries crates.io) | absent | added as `scripts/check-release-needed.mjs` (Node, queries crates.io HTTP API) so we don't need to install rust-script in CI |
| `actions/checkout@v6` | `@v4` | upgraded |
| `actions/setup-node@v6` | `@v4` | upgraded |
| `dtolnay/rust-toolchain@stable` pinned | matches | ok |
| `timeout-minutes` per job | none | added |
| Auto-detect crate name from `Cargo.toml` in release script | hard-coded `start-command` | not in this PR (the crate name is stable; tracked as follow-up) |
| `cargo-tarpaulin` cached install | reinstalled every run | added a step to use `actions/cache` for `~/.cargo/bin/cargo-tarpaulin` |

## Cross-cutting gaps

| Concern | Template behaviour | This repo before | PR #119 |
| --- | --- | --- | --- |
| Credential preflight | each release job checks tokens up front | no preflight | `scripts/preflight-credentials.mjs` runs before publish |
| Post-release verification | templates don't have this either | no verification | `scripts/verify-release-badge.mjs` runs after release |
| Debug / verbose mode in scripts | inconsistent across templates | also inconsistent | `DEBUG=1` env var prints resolved arguments and token-presence summary |

## Items deliberately *not* adopted in this PR

- Multi-runtime test matrix (Node + Bun + Deno). This repo's JS code
  uses Bun-only APIs (`bun:test`, `Bun.spawn`). Adding Node/Deno would
  require porting tests; out of scope for a CI sweep.
- Replacing `merge-changesets.mjs` with the template's exact copy. The
  in-repo version is now monorepo-aware (PR #117) and works; swapping
  it would regress.
- Replacing `create-github-release.mjs` with the template's. The
  in-repo version already supports prefixes and badges (which the
  template does not, since templates target single-language repos).

## Items the templates could adopt from this repo

- Language-prefixed tags + titles + per-version badges in releases.
  None of the templates do this (they're single-language). When a team
  forks a template into a multi-language repo, they will hit the same
  monorepo gotchas. **Not filed as upstream issues yet** because the
  templates explicitly target single-language layouts; if upstream
  wants monorepo support, the patterns from this PR are reusable.
