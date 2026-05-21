# Solution Options

## Option 1: Dedicated Wrapper Option

Add `--upload-log <id>` as a first-class wrapper query mode, parallel to
`--status` and `--list`.

Pros:

- Reuses `ExecutionStore.get()` for UUID and session-name lookup.
- Avoids parsing status text output.
- Prevents the shell fallback that caused the bug.
- Keeps upload progress visible by inheriting process stdio.

Cons:

- Requires JS and Rust parser/CLI updates.

Decision: selected.

## Option 2: Compose Through `--status --output-format json`

Teach a shell script or alias to run `--status`, parse JSON, and call
`gh-upload-log`.

Pros:

- Minimal core changes.

Cons:

- Leaves `$ --upload-log` unsupported.
- Requires fragile external composition and JSON parsing.
- Does not satisfy automatic installation as part of the command.

Decision: rejected.

## Option 3: Extend Automatic Failure Reporting Only

Install `gh-upload-log` during existing failure auto-reporting.

Pros:

- Improves one related path.

Cons:

- Does not provide the requested manual upload command.
- Changes automatic failure reporting side effects.

Decision: rejected for this issue.

## Implementation Plan

1. Extend `WrapperOptions` with `uploadLog`/`upload_log`.
2. Parse `--upload-log <id>` and `--upload-log=<id>`.
3. Include `--upload-log` in mutual-exclusion validation.
4. Add a JS uploader helper for path validation, on-demand installation, and
   inherited-stdio execution.
5. Add equivalent Rust CLI handling and failure-handler utilities.
6. Update usage docs and release fragments.
7. Add tests for parsing, mutual exclusion, upload execution, auto-install, and
   missing log-file errors.
