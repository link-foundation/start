# Timeline

- 2026-06-26 15:02:17 UTC: JavaScript CI/CD run `28246415576` started on
  `main` at commit `ffa747adf1abe07cff0daf9a27c577fbc774cf17`.
- 2026-06-26 15:02:18 UTC: Rust CI/CD run `28246415639` started on the same
  `main` commit.
- 2026-06-26: Issue #146 was opened with links to both failing workflow runs and
  a requirement to save all investigation data under this case-study folder.
- 2026-06-26: PR #147 was already prepared as a draft from branch
  `issue-146-5fd1b386b75b`.
- 2026-06-26: Recent branch runs were queried; no runs existed yet for the
  prepared branch, so the linked `main` failures were the authoritative
  evidence.
- 2026-06-26: Full logs and metadata for both cited runs were downloaded into
  this folder.
- 2026-06-26: The JS, Rust, Python, and C# pipeline templates were cloned and
  workflow inventories were saved in `data/`.
- 2026-06-26: A focused regression test was added for the JS test runner timeout
  policy. Before the runner fix it failed; after the fix it passed.
- 2026-06-26: The shared Rust template gap around Cargo HTTP/2 registry flakes
  was reported upstream as
  https://github.com/link-foundation/rust-ai-driven-development-pipeline-template/issues/83.
