# Solution Options

## Option 1: Add Alias And Fail Fast On Unknown Wrapper Options

Add `--isolation` to the same parser branches as `--isolated`, and reject
unknown dash-prefixed wrapper options.

Pros:

- Satisfies the requested alias directly.
- Prevents the reported unsafe direct-execution fallback for future typos.
- Keeps existing `-- <command>` syntax for commands that start with `-`.
- Requires only parser, docs, tests, and release metadata changes.

Cons:

- Users who previously relied on running a dash-prefixed command without `--`
  must now use the explicit separator.

Decision: selected.

## Option 2: Add Alias Only

Recognize `--isolation` but keep unknown wrapper options as silent fallthrough.

Pros:

- Smallest code change.
- Preserves every previous fallback behavior.

Cons:

- Does not satisfy the issue's request to fail on unrecognized options.
- Leaves future wrapper-option typos able to run outside the intended
  environment.

Decision: rejected.

## Option 3: Migrate To A Parser Library

Replace the custom parser with a library that supports long aliases and unknown
argument errors.

Pros:

- Moves option parsing complexity into a dedicated parser.
- Could standardize usage text generation.

Cons:

- Much larger change across two implementations.
- Higher regression risk around `start-command`'s custom wrapper-command split.
- Not necessary for this focused bug.

Decision: rejected for this issue.

## Implementation Plan

1. Add JS and Rust tests for `--isolation <env>` and `--isolation=<env>`.
2. Add JS and Rust tests for unknown dash-prefixed wrapper options.
3. Update JS and Rust parser branches for the alias.
4. Update JS and Rust unknown-option handling to return errors.
5. Update help/README docs and release metadata.
6. Run focused parser tests, then broader local CI checks.
