# start-command — Rust crate

[![Crates.io](https://img.shields.io/crates/v/start-command?style=flat)](https://crates.io/crates/start-command)
[![docs.rs](https://img.shields.io/docsrs/start-command?style=flat)](https://docs.rs/start-command)
[![Rust CI/CD](https://github.com/link-foundation/start/actions/workflows/rust.yml/badge.svg)](https://github.com/link-foundation/start/actions/workflows/rust.yml)
[![License: Unlicense](https://img.shields.io/badge/license-Unlicense-blue.svg)](../LICENSE)

Rust implementation of the [`start-command`](../README.md) CLI. The binary is
called `start` and behaves like the `$` command from the JavaScript package.

## Installation

```bash
# From crates.io (once published):
cargo install start-command

# From source:
cd rust
cargo install --path .
```

## Usage

```bash
start ls -la
start npm test
start git status
```

See the project-wide [README](../README.md), [docs/USAGE.md](../docs/USAGE.md),
and [docs/PIPES.md](../docs/PIPES.md) for the full user-facing guide.

## Development

```bash
cd rust
cargo build
cargo test
cargo fmt --all
cargo clippy --all-targets --all-features
```

## Releases

Rust releases are tagged `rust-v<version>` and published to GitHub Releases
(crates.io publishing is planned as a follow-up). The release title carries
the `[Rust]` prefix, e.g. `[Rust] 0.14.0`, so JS and Rust releases can be
told apart at a glance.

- **Release history**: https://github.com/link-foundation/start/releases?q=%5BRust%5D
- **Changelog fragments**: [`changelog.d/`](changelog.d/) — each PR adds one
  fragment with a `bump: patch|minor|major` frontmatter, which is collapsed
  into the consolidated `CHANGELOG.md` at release time.

## License

Released into the public domain under the [Unlicense](../LICENSE).
