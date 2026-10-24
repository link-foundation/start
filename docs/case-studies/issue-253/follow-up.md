# Follow-up verification, 2026-10-24

The [review request](https://github.com/link-foundation/start/pull/254#issuecomment-6382623332) asks to recheck latest versions, needed features and every encountered bug. The [continuation request](https://github.com/link-foundation/start/pull/254#issuecomment-6387637231) also asks to recover the failed session. There are no required sub-issues on #253, and all issue comments, PR conversation comments, inline comments and reviews were read.

## Recovery and repeatable audit

The [recovered session](https://gist.github.com/konard/32029f6abc1654cc2aae6bd2b6ab8680) ended with `oauth_org_not_allowed` before making changes (raw log lines 992–1005). The prepared branch was clean at `c9e10c7`. Its completed CI run was green; the authentication failure was unrelated to a code or test failure. The raw recovered log is retained locally in `ci-logs/recovery-session.log`.

A new `node scripts/check-dependency-freshness.mjs --lockfiles` run rejected **22 entries**, because the sanitizer and command-stream had new releases, with additional lockfile dependencies. [Before](data/freshness-followup-before.txt) and [after](data/freshness-followup-after.txt) outputs are retained. Both npm and Bun lockfiles were refreshed. The resulting audit checks **190 declarations, 0 stale or unverifiable**, including actions, runtimes, runners, crates, tools and the translator revision. No blocker exemption is used.

| Component                | Previous review       | Latest verified release / revision   | Features used and verification                                                                                                                                                                                                                    |
| ------------------------ | --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sensitive-data-sanitizer | 0.12.1                | 0.12.2                               | Credentials-only, environment and gh-config secrets, streaming, arbitrary bytes, bounded Authorization, idempotence and dense logs. JS and Rust regression tests cover the needed behavior; both minimum-version declarations require 0.12.2.     |
| command-stream           | 2.4.0                 | 2.6.0                                | Execution and completed output snapshots through `command-stream/core`. Tests verify stdout/stderr reach the log and compatibility/terminal/REPL modules are not loaded. Rust tests verify the same CLI logging contract using its native runner. |
| lino-objects-codec       | JS 0.9.3 / Rust 0.9.2 | Unchanged                            | Shared legacy/readable fixtures and matching encoded bytes remain covered by the existing JS and Rust tests.                                                                                                                                      |
| link-cli / clink         | C# 4.0.2              | C# 4.0.6 on NuGet                    | The latest clink was installed and real save/update/delete/consistency tests passed. CI installs the latest tool. Quoted-number and import fixes are published; the record-scoped schema remains appropriate for independent records.             |
| meta-language            | Pinned upstream main  | Unchanged pin, verified against main | Actual generated-policy regeneration with `--check`; command-stream's transitive npm meta-language is refreshed by both lockfiles.                                                                                                                |
| gh-upload-log            | 0.10.1                | Still 0.10.1 on npm                  | Private file upload remains the needed API. Local sanitization is tested on both manual and automatic uploads. The renamed package remains unavailable; see delivery limit below.                                                                 |

The detailed API/release evidence is in [upstream-followup.txt](data/upstream-followup.txt). Runtime installers without a version select the latest published package on each install; this does not upgrade an existing user's global installation automatically.

## Bugs reproduced before upgrading

The new tests failed against the old releases before the dependency changes. Raw failures are retained for [sanitizer boundaries](data/sanitizer-regression-before.txt) and [command-stream loading](data/command-stream-regression-before.txt).

Sanitizer #50 and #51 are fixed in [0.12.2](https://github.com/link-foundation/sensitive-data-sanitizer/releases/tag/v0.12.2). The integration now checks:

- `Bearer [REDACTED]`, `<token>` and `$GITHUB_TOKEN` remain unchanged.
- An arbitrary `{{token}}` is fully redacted, without trailing braces. Treating arbitrary bracketed values as credentials is intentional; the upstream report allowed either full redaction or preservation.
- NUL and ESC immediately after the token survive unchanged.
- A bracket within a credential (`ab[c]d`) does not leave a secret suffix behind.
- Sanitizing the resulting log again leaves it byte-identical.

A [bounded probe](../../../experiments/issue-253/dense-sanitizer.mjs) checks every credential and every surrounding byte with deterministic generated values. Each child has a 384 MiB JS heap limit and a 20 s deadline, and the largest input is about 256 KiB. There are no unbounded stress inputs.

| Input   | 0.12.1                                    | 0.12.2                                                         |
| ------- | ----------------------------------------- | -------------------------------------------------------------- |
| 64 KiB  | 4,840 ms                                  | 1,089 ms                                                       |
| 128 KiB | 15,809 ms                                 | 1,335 ms                                                       |
| 256 KiB | Killed at 20,049 ms by the probe deadline | 1,948 ms; all 5,699 credentials and surrounding bytes verified |

Raw output: [before](data/dense-sanitizer-0.12.1-bounded.txt), [after](data/dense-sanitizer-0.12.2-bounded.txt). A 5,700-credential regression is now in the JS suite with the same child heap/deadline bound; Rust checks the same finite log and exact output digest. The deadline detects the previous failure without increasing any production timeout. These timings describe this host, not a portable speed guarantee.

Command-stream #235 is addressed by the core entry introduced in [2.5.0](https://github.com/link-foundation/command-stream/blob/main/js/CHANGELOG.md), also present in 2.6.0. The same module hook measured **281 modules / 339 ms** for the old full import and **73 modules / 94 ms** for the new core import. Raw output: [before](data/command-stream-2.4.0-import.txt), [after](data/command-stream-2.6.0-core-import.txt). The regression asserts absence of unrelated module families instead of a host-dependent time threshold. Lazy loading still avoids this work unless the command-stream option is used. The full dependency remains installed; the core entry reduces loading cost, not installation size.

A finite [adapter compatibility probe](../../../experiments/issue-253/command-stream-helpers.cjs) also checks both execution helpers, captured stdout/stderr with exit code 7, streaming callbacks, the process runner, command discovery, path lookup and version lookup. All assertions pass on 2.6.0: [raw output](data/command-stream-helpers-2.6.0.txt).

The latest clink [4.0.6](https://github.com/link-foundation/link-cli/releases/tag/csharp-v4.0.6) preserves the corrected record-scoped queries: [probe output](data/clink-queries-4.0.6.txt). The original numeric-reference bug is fixed upstream, but a record-scoped `key=value` link is still needed so records with equal values do not share property links. Reverting the schema after the upstream fix would reintroduce that collision.

## Compatibility caught in the final diff review

The earlier draft removed the existing `ExecutionStore.recordToLinksNotation()` method while replacing its invalid query builder. Even though the old helper was unused internally, removing it could break callers of the exported store class. A [new regression failed before the fix](data/store-api-regression-before.txt). The method is restored and now supplies the corrected record-scoped property links to the create-query builder, avoiding duplicate formatters. Rust exposes and tests the same conversion. No existing query, record or CLI feature is removed.

## External delivery limit: uploader

Upstream code for gh-upload-log #55 (sanitization) and #56 (release bootstrap) was merged, and the issues were closed. A closed issue did not prove delivery: fresh registry queries still return `gh-upload-log` **0.10.1** and **E404** for `gh-upload-file`.

The [latest main release run](https://github.com/link-foundation/gh-upload-log/actions/runs/40084678223) fails its release preflight. Raw log lines 598–601 show `HAS_NPM_TOKEN: false` and the explicit error that the npm owner must bootstrap `gh-upload-file` with authorized npm publication or a repository token, then configure its trusted publisher. No version was bumped or published. The complete log is preserved locally in `ci-logs/upstream-upload-40084678223.log`; the relevant lines and fresh npm output are committed in [upstream-followup.txt](data/upstream-followup.txt).

This release delivery remains **blocked and unfinished upstream**. start cannot adopt an npm package that does not exist, and cannot perform an npm owner's authentication setup from this PR. It continues to use the latest published uploader and sanitizes private copies before either upload path. No requested start behavior depends on the unpublished uploader's sanitizer. Switching to its Git main checkout would bypass the latest-published-release policy and make installation less reliable; it was rejected. The [delivery evidence was posted back to #56](https://github.com/link-foundation/gh-upload-log/issues/56#issuecomment-6388030716), and #56 was reopened so it remains tracked.

## Verification plan

Run the entire JS lint/format/test stage locally, freshness including refreshed lockfiles, workflow guard, source/behavior parity inventory and real policy regeneration. Run Rust formatting locally; the same-commit CI Rust stage supplies clippy, all platform tests, audits, coverage and Rust CodeQL after JS passes. No independent Cargo build tree is started in the memory-limited container. Review the complete PR diff and current main ancestry, wait for every CI job, preserve failures if any and correct them together before another push.

## First follow-up CI run and correction

[Run 40122421292](https://github.com/link-foundation/start/actions/runs/40122421292) tested `ca4822c`, created at 18:48:49 UTC after the push. The entire JavaScript stage passed before Rust started. Rust lint, coverage and all three platform test jobs failed to compile the new dense-log fixture: `tests/log_sanitizer.rs:190` formatted a SHA-256 digest with `{:x}`, but sha2 0.11's byte-array return type no longer implements `LowerHex`. See the [job log excerpts with line numbers](data/rust-fixture-compile-failure.txt). Coverage's broken pipe and missing measurement follow from this compiler failure, not a second runtime defect.

Every job was allowed to finish, and complete raw run/job logs were preserved in `ci-logs/` before the correction was pushed. Rust CodeQL and the other workflows passed. The correction uses the byte-by-byte `{:02x}` formatter already used in `rust/src/lib/store_decode_cache.rs`, preserving the exact SHA-256 token input shared with JavaScript. No runtime code, coverage threshold or timeout is changed. The final same-commit CI run verifies the corrected fixture along with the whole platform matrix.

## Local verification results

- `cd js && bun run check && PATH="/tmp/issue-253-clink:$PATH" bun run test`: 1,572 pass, 1 explicit tmux skip, 0 fail (1,573 tests in 107 files, 350.26 s). The latest clink 4.0.6 was available throughout the final full run, including the save/update/delete/consistency and rename tests.
- The real clink save/update/delete/consistency suite: 3 pass, 0 fail.
- Workflow guard, source inventory/parity, policy regeneration `--check` and Rust formatting pass locally. Rust compilation and the full platform matrix are verified by CI after the JavaScript stage.
