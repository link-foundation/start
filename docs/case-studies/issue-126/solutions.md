# Solution Options

## Option 1: Local formatter repair

Update the existing local formatters to indent array delimiter lines at the
same nested depth as the values they contain. Add regression tests for
`processIds.commandPids`.

Selected because it is small, directly fixes the bug, and does not require a
new dependency contract.

## Option 2: Delegate status formatting to `lino-objects-codec`

Replace custom status-output formatting with a dependency-provided encoder.
This would reduce local Links Notation code, but it needs a deliberate output
contract review because current CLI output is a user-facing format and has
custom ordering/readability choices.

Not selected for this PR because it is higher risk than the reported bug.

## Option 3: Keep Rust inline JSON arrays

Fix only JavaScript. This would address the exact sample but leave Rust output
divergent.

Not selected because the repository maintains parallel JavaScript and Rust
implementations.

## Implemented Plan

1. Add failing JavaScript tests for nested arrays and CLI status output.
2. Add a Rust formatter regression test for `processIds.commandPids`.
3. Fix JavaScript array delimiter indentation in `formatAsNestedLinksNotation`.
4. Add Rust nested-array appenders for status and control Links Notation output.
5. Update direct dependencies and lockfiles.
6. Run targeted and broad local checks.
