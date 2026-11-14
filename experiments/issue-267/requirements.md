# Issue #267 work plan

Objective: implement and verify every requirement in issue #267 in PR #268.
The issue and all three PR feedback streams were read on 2026-11-14; none
contains additional comments or required sub-issues.

| Requirement | Implementation / evidence | Status |
| --- | --- | --- |
| Decide whether schemes and URL usernames may remain public | Accept 0.22.4 output: schemes and usernames provide context; credentials, environment secrets and gh tokens remain masked. Document in both READMEs and release notes. | Decided |
| Upgrade JavaScript and both lockfiles | `js/package.json`, `js/bun.lock`, `js/package-lock.json`, latest published 0.22.5 | Implemented |
| Upgrade Rust installer and minimum | `rust/src/lib/log_sanitizer.rs`, minimum 0.22.5 | Implemented |
| Preserve NUL and invalid UTF-8 bytes | Shared `--allow-binary` options for logs and issue text. Exact-byte regression coverage in both editions. | JS verified; Rust CI pending |
| Adopt new output without losing surrounding data | JS/Rust sanitizer tests: Authorization, Proxy-Authorization, URL passwords, JSON, long tokens, placeholders, idempotence, dense credentials and issue text. | 54 focused JS tests pass; Rust CI pending |
| Remove obsolete dependency blocker | Delete `.github/dependency-blockers.json`; freshness check covers 190 dependencies with zero stale/unverifiable entries and zero blockers. | Verified |
| Prepare releases | JS changeset and Rust changelog fragment; versions remain CI-managed. | Implemented |
| Verify locally | JS check/test; focused sanitizer/integration, parity, workflow and generated-policy checks. Avoid local Rust compilation unless needed. | Passed; 1760 full-suite passes, 8 optional-service skips, zero failures |
| Finalize PR | Preserve all failed CI logs; wait for older runs before push; review complete diff, main ancestry, clean worktree, all checks; update PR and mark ready. | Pending |

No public CLI parsing, isolation, status or record format changes are needed;
the existing failure-reporting feature already inventories both sanitizer
implementations and tests.

Reproduction: after upgrading the dependency, the old JS tests fail in five
output assertions plus the JS/Rust version agreement assertion. The finite
`repro.cjs` separately confirms `ERR_BINARY` for issue text with NUL before
the adapter fix; afterwards both paths keep the exact NUL and following bytes.
Compressed raw logs are in `before-tests.log.gz`, `before-nul.log.gz`,
`after-nul.log.gz`, `after-nul-node.log.gz`, `focused-tests.log.gz` and
`all-tests.log.gz` in this directory. The 8 full-suite skips require tmux,
clink or a real Formal AI runtime; all sanitizer and upload tests execute.

The registry and upstream release metadata show 0.22.5 was published on
2026-11-14, after 0.22.4. It includes the NUL fix and a Markdown placeholder
fix, so both editions require this latest patch. The initial freshness probe
also found `taiki-e/install-action` v2.90.4 newly published; its sole pin is
updated without changing the existing JavaScript gate for Rust jobs.
