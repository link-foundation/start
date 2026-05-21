# Issue 128 Case Study: `$ --upload-log` Support

## Summary

Issue #128 reports that `$ --upload-log <session-id>` is treated as a shell
command and fails with `/bin/sh: 0: Illegal option --`. The requested behavior is
for `start-command` to resolve the tracked execution's `logPath` and run
`gh-upload-log <logPath>` so the uploader output is visible to the caller.

## Evidence Collected

- Issue data: [issue-data.json](issue-data.json)
- Issue comments: [issue-comments.json](issue-comments.json)
- Uploaded log excerpt: [data/gist-evidence.txt](data/gist-evidence.txt)
- Related package metadata: [data/gh-upload-log-npm.json](data/gh-upload-log-npm.json)
- Related repository metadata: [data/gh-upload-log-repo.json](data/gh-upload-log-repo.json)
- Recent merged PRs reviewed for style: [data/recent-merged-prs.json](data/recent-merged-prs.json)

## Implemented Plan

1. Add `--upload-log <uuid-or-session-name>` parsing to the JavaScript and Rust
   argument parsers.
2. Keep the option mutually exclusive with `--status`, `--list`, `--stop`,
   `--terminate`, and `--cleanup`.
3. Resolve the execution record with the existing `ExecutionStore.get()` lookup,
   which already supports UUIDs and isolation session names.
4. Validate that the resolved record has an existing `logPath`.
5. Ensure `gh-upload-log` is available, installing it with Bun or npm when
   missing.
6. Run `gh-upload-log <logPath>` with inherited stdio so the upload progress and
   resulting URL are visible.
7. Cover the behavior with parser and CLI tests.

## Outcome

The new option is a first-class query action rather than a command passed to the
shell. That removes the reported `/bin/sh` failure mode and reuses the same
execution tracking data that powers `--status`.
