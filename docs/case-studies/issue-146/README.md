# Case Study - Issue #146: CI/CD False Positives and Errors

- Issue: https://github.com/link-foundation/start/issues/146
- Pull Request: https://github.com/link-foundation/start/pull/147
- JavaScript run cited by the issue: https://github.com/link-foundation/start/actions/runs/28246415576
- Rust run cited by the issue: https://github.com/link-foundation/start/actions/runs/28246415639

## Documents in this folder

| File | Purpose |
| --- | --- |
| `requirements.md` | Explicit and implied requirements from issue #146. |
| `timeline.md` | Sequence reconstructed from issue, PR, and CI metadata. |
| `root-cause.md` | Root causes for the linked workflow failures, with log references. |
| `solutions.md` | Implemented fixes and verification plan/results. |
| `template-comparison.md` | Comparison against JS, Rust, Python, and C# pipeline templates. |
| `online-research.md` | Official documentation used to validate the changes. |
| `template-rust-http2-issue.md` | Body of the upstream Rust template issue filed from this investigation. |
| `ci-logs/` | Raw `gh run view --log` output for the two cited workflow runs. |
| `data/` | GitHub metadata, inventories, and focused reproducer logs. |
| `templates/` | Snapshot of local and template workflow files reviewed for this case. |

## Summary

Two independent CI failures were present on `main` at commit
`ffa747adf1abe07cff0daf9a27c577fbc774cf17`.

The JavaScript workflow failed because repository tests were running with Bun's
default 5000 ms per-test timeout. The failed tests were integration-style
process tests that can legitimately take longer on GitHub-hosted runners. The
JS template already uses `bun test --timeout 30000`; this repo had a shared test
runner but no default timeout in that runner.

The Rust workflow failed in the build job while Cargo was downloading
`wasm-bindgen-shared` from crates.io. The log shows a transient libcurl HTTP/2
framing error, not a Rust compile or packaging defect. The same run also emitted
`actions/cache@v4` Node 20 deprecation warnings, and the workflow's
`hashFiles('rust/Cargo.lock')` cache key had no committed lockfile to hash.

The fix adds a tested 30 second default to the JS test runner, hardens the Rust
workflow's Cargo registry behavior, upgrades Rust cache steps to
`actions/cache@v5`, and commits `rust/Cargo.lock` so the existing cache keys are
real. The shared Rust template risk was reported upstream:

- https://github.com/link-foundation/rust-ai-driven-development-pipeline-template/issues/83
