# Root Cause Analysis

## Documentation Drift

Docker isolation behavior changed before this issue: both JavaScript and Rust
now assign a default Docker image when `--isolated docker` is used without
`--image`. The parser comments and Rust usage text already reflected that
behavior, but older documentation still said `--image` was required.

The stale references survived because examples were mostly prose. There was no
central manifest of documented examples and no CI step that compared documented
output with actual CLI output.

## Output Drift Risk

`start-command` output contains dynamic values: UUIDs, timestamps, durations,
and local log paths. Without normalization, documented output is either left as a
rough sketch or becomes brittle. The new example checker treats those fields as
placeholders and compares the stable structure around them.

## Docker Example Gaps

Existing docs used generic images such as Bun or Alpine. Issue #124 asked for
examples based on `link-foundation/box`, because those images are closer to real
AI coding experiments: they include language runtimes and development tooling.

## CI Trigger Gap

The workflows already had conditions for documentation changes after they were
started, but their path filters did not start CI for docs-only changes. The path
filters now include top-level docs, `docs/**`, and `examples/**`, so doc example
checks can run when documentation changes.
