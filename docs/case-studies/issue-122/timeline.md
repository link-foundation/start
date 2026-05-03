# Timeline - Issue #122

All timestamps are UTC.

## 2026-05-03 17:57

Two `main` push workflows started for commit
`ea5d0db74892e34c19b353993ec3169acd0ae27e`:

- JavaScript CI/CD run `25286510018`
- Rust CI/CD run `25286510029`

The recent run snapshot is stored in `recent-runs.json`.

## 2026-05-03 17:59

Rust CI/CD run `25286510029` reached Auto Release. The release detector found:

```text
Already published: false
Output: should_release=true
Output: skip_bump=true
```

Source: `ci-logs/rust-cicd-25286510029.log` lines 7615-7617.

This means the workflow knew the `start-command` crate version was not present
on crates.io and that a release action was required.

## 2026-05-03 17:59

The Rust Auto Release job called the GitHub Releases API. GitHub rejected the
request because the release tag already existed:

```text
gh: Validation Failed (HTTP 422)
{"message":"Validation Failed","errors":[{"resource":"Release","code":"already_exists","field":"tag_name"}],...}
```

The same log line then printed:

```text
Created GitHub release: rust-v0.14.1 ([Rust] 0.14.1)
```

Source: `ci-logs/rust-cicd-25286510029.log` lines 7718-7719.

The workflow concluded `success`, so the failure was hidden from CI status.

## 2026-05-03 18:00

JavaScript CI/CD run `25286510018` failed on the Windows Bun test matrix. The
failing test was:

```text
Isolation Resource Cleanup Verification > docker resource cleanup > should keep docker container running when keepAlive is true
```

It ran for about 16 seconds and then Bun reported:

```text
this test timed out after 5000ms
```

Source: `ci-logs/javascript-cicd-25286510018.log` lines 6574-6575.

The same test passed on Ubuntu, macOS, and coverage jobs with shorter timings,
which pointed to Windows Docker startup/inspection latency rather than failed
cleanup behavior.

## 2026-05-03 18:08

Issue #122 was opened with the two run links and requirements to preserve data,
compare templates, identify root causes, and report template bugs.

Source: `issue-data.json`.

## Investigation

The investigation downloaded:

- complete logs for the two cited runs,
- workflow run metadata,
- recent workflow run history,
- issue and PR metadata,
- relevant workflow and release helper files from all requested templates.

Local Rust packaging checks then exposed an additional blocker: the Rust crate
was not publishable as-is. A full `cargo package --allow-dirty` check initially
failed because `start-command` depended on
`lino-objects-codec = { path = "../lib/lino-objects-codec" }` without a registry
version. After adding a version, Cargo resolved the published
`lino-objects-codec 0.2.0`, whose API uses `LinoValue`; `start-command` still
used the old serde_json `Value` API. The final fix uses the registry
dependency and explicit conversion functions.

## Resolution plan

The implemented plan:

1. Add explicit Docker-aware timeouts to the failing JavaScript cleanup tests.
2. Replace the unchecked GitHub release helper with a helper that checks `gh`
   exit status and treats only `already_exists` as an idempotent skip.
3. Add an idempotent crates.io publish helper.
4. Add Rust workflow steps that publish to crates.io before creating the GitHub
   Release.
5. Gate GitHub Release creation and verification on successful crates.io
   publish.
6. Make `start-command` packageable against the published
   `lino-objects-codec 0.2.0` crate.
7. Upgrade Rust package verification from `cargo package --list` to full
   package verification.
8. Add regression tests and release fragments.
