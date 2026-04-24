# start-command — JavaScript package

[![npm version](https://img.shields.io/npm/v/start-command?style=flat)](https://www.npmjs.com/package/start-command)
[![npm downloads](https://img.shields.io/npm/dm/start-command?style=flat)](https://www.npmjs.com/package/start-command)
[![JavaScript CI/CD](https://github.com/link-foundation/start/actions/workflows/js.yml/badge.svg)](https://github.com/link-foundation/start/actions/workflows/js.yml)
[![License: Unlicense](https://img.shields.io/badge/license-Unlicense-blue.svg)](../LICENSE)

JavaScript/Bun implementation of the [`start-command`](../README.md) CLI (`$`).

## Installation

```bash
bun install -g start-command
# or, via npm:
npm install -g start-command
```

## Usage

```bash
$ ls -la
$ npm test
$ git status
```

See the project-wide [README](../README.md), [docs/USAGE.md](../docs/USAGE.md),
and [docs/PIPES.md](../docs/PIPES.md) for the full user-facing guide.

## Development

```bash
cd js
bun install
bun test
bun run lint
```

## Releases

JavaScript releases are tagged `js-v<version>` and published to both npm and
GitHub Releases. The release title carries the `[JavaScript]` prefix, e.g.
`[JavaScript] 0.25.4`, so JS and Rust releases can be told apart at a glance.

- **Release history**: https://github.com/link-foundation/start/releases?q=%5BJavaScript%5D
- **CHANGELOG**: [`CHANGELOG.md`](CHANGELOG.md) (per-package changelog generated
  by [Changesets](https://github.com/changesets/changesets))

## License

Released into the public domain under the [Unlicense](../LICENSE).
