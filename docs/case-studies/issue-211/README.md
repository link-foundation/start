# Issue 211: Rust releases stuck at 0.24.0

From 2026-10-10 to 2026-10-13, every `Rust CI/CD / Auto Release` run ended green
without publishing anything. The Rust half of #205/#206 (PR #208) and #209
(PR #210) never reached crates.io. Three independent defects were involved.

## 1. The writer jobs pushed with `GITHUB_TOKEN` (fixed by PR #215)

`START_RELEASE_SSH_KEY` is an environment secret of `release-main`. `js.yml`
called `rust.yml` without passing secrets, so the key was empty in the called
release jobs. The checkout fell back to `GITHUB_TOKEN`, and ruleset 24848039
(bypass: `DeployKey` only) rejected the push with `GH013`. PR #215 added
`secrets: inherit`. In run [38359465127](https://github.com/link-foundation/start/actions/runs/38359465127)
the key arrives and the push lands ([excerpt](data/run-38359465127-rust-auto-release.txt)):

```
ssh-key: ***
git remote add origin git@github.com:link-foundation/start.git
[main b1e1cfb] rust-v0.24.0
✅ Version bump committed and pushed to main
```

## 2. A failed git command was reported as success

command-stream's `$` resolves on a non-zero exit code.
[`experiments/issue-211-rejected-push.mjs`](../../../experiments/issue-211-rejected-push.mjs)
reproduces it against a bare remote whose `pre-receive` hook rejects the push:
`{ threw: false, code: 1, stderr: "remote: GH013: ..." }`.

PR #215 checked the exit code of `git push` only. This PR routes every git and
version command of `scripts/version-and-commit.mjs` through `checked()` in
`scripts/release-git.mjs`. After the push, `verifyCommitOnRemote()` fetches
main and requires the version commit to be an ancestor of `origin/main`. An
ancestry check is used instead of comparing heads, because another commit may
land on main right after the push.

## 3. The bump reused a version crates.io already had

Run 38359465127 also shows the defect that remained after PR #215:

```
New version: 0.24.0
start-command@0.24.0 is already published to crates.io
publish_result=already_published
GitHub release already exists: rust-v0.24.0 ([Rust] 0.24.0)
```

`rust/Cargo.toml` on main was 0.23.0. crates.io had had 0.24.0 since
2026-10-10T18:58:46Z ([data](data/crates-io-0.24.0.txt)), built from an
older tree. The minor bump picked 0.24.0 again, the publish step treated it as
a self-healing no-op, and the run ended green. The changelog fragments
204/208/210/211 were consumed into a `## [0.24.0]` entry that crates.io does
not contain.

Fix:

- `nextUnpublishedVersion()` keeps bumping until crates.io answers 404, and
  fails closed on any other response. In
  [`experiments/issue-211-version-and-commit-e2e.mjs`](../../../experiments/issue-211-version-and-commit-e2e.mjs),
  0.23.0 + minor with 0.24.0 taken yields 0.25.0.
- `publish-to-crates.mjs` reports `published_before_run=true` when the version
  existed before it tried to publish. `rust.yml` fails the job if that version
  was committed by the same run. A retry that finds its own earlier upload does
  not set the output, so it is not a false positive.
- A maintainer ran a manual minor release at 07:10Z (commit 69c82b4,
  `rust-v0.25.0`). crates.io has had `start-command@0.25.0` since
  2026-10-13T07:11:48Z, built from a tree that includes PR #208 and PR #210.
  The `## [0.24.0]` entry is annotated as not on crates.io, and the 0.25.0
  entry says that it ships those changes. `rust/changelog.d/211.md` is a patch
  fragment for the automation fix itself.

## Not implemented: "fragments remain on main" check

The issue suggested failing when `rust/changelog.d/*.md` remains on main after a
release run. A PR merged during the release can add a new fragment, so that
check would fail spuriously. The ancestry check verifies the same thing
directly: the commit that removed the fragments is on main.

## Tests

- `js/test/release-git.mjs`: rejected push (bare remote with a `pre-receive`
  hook), ancestry check before and after main moves on, version skipping with a
  fake crates.io, and failing closed on HTTP 503.
- `js/test/publish-to-crates.mjs`: `published_before_run` is set only when the
  version already existed.
