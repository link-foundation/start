# Root Cause Analysis - Issue #122

## RC1. JavaScript Docker cleanup tests used Bun's default 5 second timeout

The cited JavaScript run failed in the Windows Bun matrix:

```text
(fail) Isolation Resource Cleanup Verification > docker resource cleanup > should keep docker container running when keepAlive is true [16016.00ms]
  ^ this test timed out after 5000ms, before its done callback was called.
```

Source: `ci-logs/javascript-cicd-25286510018.log` lines 6574-6575.

The same workflow log shows the same test passing elsewhere:

- coverage job: 1890 ms, line 1395,
- macOS Bun job: 3.51 ms, line 2754,
- Ubuntu Bun job: 1942 ms, line 4236.

This pattern isolates the failure to Windows Docker latency. The test was not
failing because the keep-alive behavior was wrong; it was failing because the
test still inherited the default 5000 ms test timeout. A nearby Docker test file
already used larger Docker-specific timeouts, so the intended local pattern was
to give Docker integration tests enough time on slower runners.

## RC2. Rust Auto Release did not publish to crates.io

Rust CI/CD run `25286510029` concluded successfully, but Auto Release only
built artifacts and then attempted to create a GitHub Release. There was no
`cargo publish` step in `.github/workflows/rust.yml`.

The release detector already knew the crate version was missing from crates.io:

```text
Already published: false
Output: should_release=true
Output: skip_bump=true
```

Source: `ci-logs/rust-cicd-25286510029.log` lines 7615-7617.

That information was not connected to any publish action, so a green workflow
could still leave crates.io unchanged.

## RC3. GitHub release creation printed success after `gh api` failed

The Rust release job called GitHub's Create Release endpoint for an existing
tag. GitHub returned HTTP 422:

```text
gh: Validation Failed (HTTP 422)
{"message":"Validation Failed","errors":[{"resource":"Release","code":"already_exists","field":"tag_name"}],...}
```

The helper then printed a success message:

```text
Created GitHub release: rust-v0.14.1 ([Rust] 0.14.1)
```

Source: `ci-logs/rust-cicd-25286510029.log` lines 7718-7719.

The old `scripts/create-github-release.mjs` used command-stream `.run({ stdin:
payload })` and never checked the command result. That made a failed GitHub API
call look successful to the workflow and to maintainers reading the logs.

## RC4. The Rust crate was not publishable as packaged

Local package verification exposed a packaging problem that the workflow did
not catch because it used `cargo package --list`, which lists package contents
but does not verify a publishable tarball.

The first full package check failed because `start-command` used a local path
dependency without a registry version:

```text
all dependencies must have a version requirement specified when packaging.
dependency `lino-objects-codec` does not specify a version
```

After adding a version matching the local crate, Cargo tried to resolve that
version from crates.io and failed because crates.io currently has
`lino-objects-codec 0.2.0` rather than `0.1.0`.

After switching to the published crate version, `start-command` then failed to
compile because `lino-objects-codec 0.2.0` exposes `LinoValue` instead of the
old serde_json `Value` API used by `execution_store.rs`.

The release workflow had to verify the real publishable package and the code
had to compile against the same dependency that crates.io users will resolve.

## RC5. Template drift existed in the JS template, not the Rust template

The Rust pipeline template already had the two practices missing here:

- a crates.io publish step,
- a release helper that checks process exit status and handles existing
  releases explicitly.

The JS template still had the unchecked `gh api` helper pattern. That is a
real upstream bug because it can produce the same false-positive "release
created" message. It was reported upstream:

- https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/49

The Python and C# templates did not contain the exact same silent success bug.
Python checks subprocess failures. C# uses `execSync`, which fails on unexpected
non-zero exits, although its existing-release handling is less explicit than
the Rust template.
