# Issue 126 Case Study: Links Notation Process ID Formatting

Issue: https://github.com/link-foundation/start/issues/126

Pull request: https://github.com/link-foundation/start/pull/127

## Summary

The reported output placed the opening parenthesis for `processIds.commandPids`
at column 1:

```text
  processIds
      commandPids
(
        667121
      )
```

The expected output keeps the array block under the parent key:

```text
  processIds
      commandPids
        (
          667121
        )
```

The root cause is local formatter logic, not a dependency defect. The
JavaScript helper emitted array delimiters without a block indent. The Rust
status/control formatters serialized arrays as inline JSON in this path.

## Data

- `issue-data.json`: issue body and metadata.
- `issue-comments.json`: issue comments. Empty at investigation time.
- `pr-127.json`: prepared pull request metadata before final update.
- `related-prs.json`: recent merged PRs touching status and Links Notation.
- `recent-runs.json`: branch CI run list. Empty before this branch had pushed
  solution commits.
- `reproduction-after-js.log`: local formatter output after the fix.
- `data/`: dependency and audit snapshots.

## Result

The fix adds regression coverage for the nested array case and updates the
formatters so nested arrays render as indented Links Notation blocks in both
JavaScript and Rust.
