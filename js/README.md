# start-command — JavaScript package

[![npm version](https://img.shields.io/npm/v/start-command?style=flat)](https://www.npmjs.com/package/start-command)
[![npm downloads](https://img.shields.io/npm/dm/start-command?style=flat)](https://www.npmjs.com/package/start-command)
[![JavaScript CI/CD](https://github.com/link-foundation/start/actions/workflows/js.yml/badge.svg)](https://github.com/link-foundation/start/actions/workflows/js.yml)
[![License: Unlicense](https://img.shields.io/badge/license-Unlicense-blue.svg)](../LICENSE)

JavaScript/Bun implementation of the [`start-command`](../README.md) CLI (`$`).

## Installation

```bash
bun install -g start-command

# Also available from npm registries:
npm install -g start-command
```

## Usage

```bash
$ echo "Hello World"
$ ls -la
$ bun test
$ git status
$ --list
$ --help
$ -i docker -d --label task.tool=codex -- my-task
$ --attach <id>
$ --resume <id> -- <command>
$ --resume-all
```

See the project-wide [README](../README.md), [docs/USAGE.md](../docs/USAGE.md),
[docs/PIPES.md](../docs/PIPES.md), and
[docs/EXAMPLES.md](../docs/EXAMPLES.md) for the full user-facing guide and
checked examples.

`-h` also prints usage. Labels persist across Docker resumes. New detached
containers support copy-free command handoff; legacy snapshots require capacity
preflight. Log uploads are private and sanitized; manual `--no-sanitize` opts out.

## Development

```bash
cd js
bun install
bun run test
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

### Docker resource and recovery controls

Launch with `--memory 64m`, `--memory-swap 64m` and `--cpus 1`, or use daemon
percentages and uniform ranges such as `--memory '70%-80%'`. Memory-swap defaults
to memory. `--cpu-penalty` enables delayed caps and reports state through status.
Manual `--resume <id> --memory 128m` updates before starting;
`--on-kill-resume-memory` changes memory only after a fresh qualifying OOM.
See the [full resource and recovery guide](../README.md#docker-launch-limits-recovery-limits-and-cpu-penalty)
and [incident research](../docs/case-studies/issue-195/README.md).
