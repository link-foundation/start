# Harden Cargo registry downloads against transient HTTP/2 framing failures

While fixing link-foundation/start#146, the Rust workflow failed during the push-to-main build job with a Cargo registry download error:

```text
failed to load source for dependency `wasm-bindgen-shared`
unable to update registry `crates-io`
download of wa/sm/wasm-bindgen-shared failed
curl failed
[16] Error in the HTTP2 framing layer
```

Evidence:

- Failing run: https://github.com/link-foundation/start/actions/runs/28246415639
- Downloaded log in the case study: `docs/case-studies/issue-146/ci-logs/run-28246415639.log`
- The exact failure appears at log lines 7476-7490 in that saved log.

The start repo now hardens Cargo network behavior with:

- `CARGO_NET_RETRY: '10'`
- `CARGO_HTTP_MULTIPLEXING: 'false'`

It also committed `rust/Cargo.lock` because the workflow already used `hashFiles('rust/Cargo.lock')` for cargo cache keys, but the file was ignored locally.

The Rust pipeline template already has two relevant best practices that the start repo was missing:

- `actions/cache@v5`
- a `Cargo.lock` guard for binary crates

The one remaining shared risk is transient Cargo sparse-index/download failures. The template could adopt the same workflow-level Cargo network environment variables or document them as a recommended hardening option for release/build jobs that hit HTTP/2 framing flakes.
