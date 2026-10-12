# Issue 212 / PR 213 — CI/CD warnings, false positives and false negatives

## Evidence collected
- `runs-main.json` — last 20 runs on `main` (all green at the time of the issue).
- `ci-logs/run-<id>.log.gz` + `run-<id>.json` — full logs and job lists for the five runs in the issue
  (Security 38267947238, JavaScript 38263438719, Links 38263163964, Workflows 38262574478, Rust 37995995760).
- `analysis/annotations.txt` — every check-run annotation from those runs (deduplicated, counted).

## Timeline
1. `176b6f9` (0.37.2) released; all five workflows concluded `success`.
2. `/fix --ci-cd` opened #212 asking to remove all warnings / false positives / negatives.
3. Log scan (`grep -iE 'warning|deprecat|::error'`) + annotation scan of all jobs performed here.

## Findings and root causes
| # | Signal | Root cause | Fix |
|---|--------|-----------|-----|
| 1 | `warning: cargo publish --token is deprecated in favor of using cargo login and environment variables` (Rust run 37995995760, publish step) | `scripts/publish-to-crates.mjs` passed the token as `--token <token>` argv (also exposes the secret in the process list). | Pass it via Cargo's native `CARGO_REGISTRY_TOKEN` env var, as the Rust template's `scripts/publish-crate.rs` does. Regression test in `js/test/publish-to-crates.mjs` asserts argv has no `--token` and the env var carries the token (fails before fix, passes after). |
| 2 | 34× notice `The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026` ([runner-images#14748](https://github.com/actions/runner-images/issues/14748)) | All jobs used floating `ubuntu-latest` (matrices also `macos-latest`/`windows-latest`); image upgrades silently change toolchains → future unexplained failures. | Pin `ubuntu-24.04`, `macos-15`, `windows-2025`, matching the JS/Rust/Python templates (all already pin `ubuntu-24.04`). |
| 3 | Notice `macOS arm64 runners may experience longer queue times` | GitHub capacity notice, not actionable in this repo. | None. |
| 4 | `Skipping: docker/ssh/screen/tmux/POSIX sh not available` test lines | Intentional platform-conditional skips on macOS/Windows matrices; Linux job runs those suites. Not false negatives. | None. |
| 5 | CodeQL `DEPRECATED buildless` text | Part of CodeQL's own config schema dump, not a used option. | None. |
| 6 | `(pass) ... (deprecated alias)` | Test names for intentionally kept aliases. | None. |

## Template comparison
The templates were re-checked for the two concrete differences found: runner pinning (all templates pin
`ubuntu-24.04`) and crates.io token passing (Rust template uses `CARGO_REGISTRY_TOKEN`). Neither problem
exists in the templates, so no upstream template issues were filed. A full file-tree comparison was done
earlier in issue 168 (`dev/log/issues/168/pulls/169`).
