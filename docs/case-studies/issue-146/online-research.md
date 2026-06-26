# Online Research

## Bun Test Runner

- Source: https://bun.com/docs/cli/test
- Relevant point: Bun's `--timeout` option sets the per-test timeout in
  milliseconds, and the documented default is 5000.
- Application: the repo's shared JS test runner now supplies `--timeout 30000`
  unless a caller provides an explicit timeout.

## Cargo Configuration

- Source: https://doc.rust-lang.org/cargo/reference/config.html
- Relevant points:
  - `net.retry` can be controlled with `CARGO_NET_RETRY`.
  - `http.multiplexing` can be controlled with `CARGO_HTTP_MULTIPLEXING`.
- Application: the Rust workflow now increases retry count and disables HTTP
  multiplexing to avoid the observed libcurl HTTP/2 framing failure.

## Cargo.lock Policy

- Source: https://blog.rust-lang.org/2023/08/29/committing-lockfiles/
- Relevant point: Rust's guidance starts from committing `Cargo.lock`,
  especially for packages with binaries.
- Application: this repository publishes a binary target named `start`, and the
  workflow already expected `rust/Cargo.lock` for cache keys, so the lockfile is
  now committed.

## GitHub Actions Cache

- Source: https://github.com/actions/cache
- Relevant point: the current `actions/cache@v5` release runs on the Node 24
  runtime.
- Application: the Rust workflow now uses `actions/cache@v5`, matching the Rust
  template and removing the `actions/cache@v4` Node 20 warning seen in the cited
  run.
