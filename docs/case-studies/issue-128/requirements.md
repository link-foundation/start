# Requirements

## Functional Requirements

1. `$ --upload-log <id>` must be recognized by `start-command` instead of being
   forwarded to the shell.
2. `<id>` must identify a tracked execution by UUID or by isolation session name,
   matching the lookup behavior of `--status`.
3. The command must read the execution record's stored `logPath` internally.
4. The command must run `gh-upload-log <logPath>`.
5. `gh-upload-log` stdout and stderr must remain visible to the caller.
6. If `gh-upload-log` is missing, the command must attempt automatic
   installation.
7. Missing execution records, missing log paths, and missing log files must
   produce clear errors.
8. Query/control modes must remain mutually exclusive.

## Repository Process Requirements

1. Collect issue data under `docs/case-studies/issue-128`.
2. Include deep case-study analysis, requirements, possible solutions, and
   relevant online/repository research.
3. Add tests that reproduce the reported bug and verify the fix.
4. Add release metadata for both JavaScript and Rust packages.
