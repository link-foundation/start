# Case Study: Issue #110 - `--list` for tracked command executions

## Summary

Issue #110 reports that `$ --list` is executed as a shell command instead of
being handled by start-command:

```bash
$ --list
/bin/sh: 0: Illegal option --
```

The expected behavior is a Links Notation list of every command execution that
start-command stores for later `--status` lookups. The issue explicitly asks for
JavaScript and Rust parity and for the analysis data to be stored in this folder.

## Contents

- `issue-data.json` - raw issue metadata from GitHub.
- `issue-comments.json` - raw issue comments from GitHub.
- `related-prs.json` - recent related merged PRs reviewed during investigation.
- [requirements.md](requirements.md) - requirements extracted from the issue.
- [timeline.md](timeline.md) - observed reproduction and implementation sequence.
- [root-cause.md](root-cause.md) - why `--list` failed.
- [solutions.md](solutions.md) - considered solution options and chosen plan.
- [online-research.md](online-research.md) - external references reviewed.

## Reproduction

Before the fix, both implementations passed `--list` through as the command:

```bash
START_DISABLE_AUTO_ISSUE=1 bun js/src/bin/cli.js --list
START_DISABLE_AUTO_ISSUE=1 cargo run --manifest-path rust/Cargo.toml -- --list
```

Both failed with `/bin/sh: 0: Illegal option --`.

## Fixed behavior

`--list` is now a query mode, like `--status`:

```bash
$ --list
executions
  count 2
  records
    91ae2198-e7b4-42d2-b501-648a7fb6d0b8
      uuid 91ae2198-e7b4-42d2-b501-648a7fb6d0b8
      status executing
      command "sleep 60"
      ...
```

It defaults to Links Notation and also supports the same query output formats as
`--status`:

```bash
$ --list --output-format json
$ --list --output-format text
```

## Verification

Focused checks added for this issue:

```bash
cd js
bun test test/args-parser.test.js test/status-query.test.js

cargo test --manifest-path rust/Cargo.toml --test args_parser_test --test status_formatter_test
```

