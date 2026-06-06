# Requirements

## Functional Requirements

1. `--isolation <env>` must be accepted as an alias for `--isolated <env>`.
2. `--isolation=<env>` must be accepted as an alias for `--isolated=<env>`.
3. The alias must work before an explicit `--` command separator.
4. The alias must work in the no-separator form where the command starts at the
   first non-option argument.
5. The JavaScript and Rust implementations must expose the same parser behavior.
6. Unknown dash-prefixed wrapper options must fail immediately instead of being
   skipped or treated as the command to run.
7. The explicit `--` command separator must remain available for commands whose
   first token starts with `-`.

## Repository Process Requirements

1. Collect issue and PR data under `docs/case-studies/issue-130`.
2. Include case-study analysis, requirements, root cause, options, timeline, and
   relevant online/repository research.
3. Add regression tests that fail before the fix and pass after it.
4. Add release metadata for both JavaScript and Rust package workflows.
