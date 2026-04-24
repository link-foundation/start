# Timeline — Issue #108

## Before the issue

- **2026-01-07 – 2026-01-08**: JavaScript package `start-command` is
  published repeatedly (`v0.17.x`, `v0.18.0`, `v0.19.x`, `v0.20.x`).
  Releases use the plain tag `v<version>` with title `<version>`.
- **2026-03-03 – 2026-04-23**: Further JS releases (`v0.21.0` –
  `v0.25.4`). Still no language prefix on either the tag or the release
  title.

## Rust workflow goes live

- The `rust/` crate is added to the mono-repo alongside the JS package.
- `.github/workflows/rust.yml` is added with an `auto-release` job that
  is supposed to create `rust-v<version>` releases on push to `main`.
- `scripts/create-github-release.mjs` is reused from the JS pipeline and
  is invoked with `--prefix rust-` from `rust.yml` and `--prefix js-`
  from `js.yml`.

## The silent failure

Every push to `main` that touches `rust/**` triggers the Rust workflow.

- `detect-changes`, `lint`, `test (ubuntu/macos/windows)`, `coverage`,
  and `build` all complete with `conclusion: success`.
- The `auto-release` job, however, is reported as
  `conclusion: "skipped"` with an empty `steps: []`.

On every run (including runs on `2026-03-03`, `2026-03-13`, `2026-04-08`,
`2026-04-19`, and `2026-04-23`) the job simply never started.

The workflow returns `conclusion: success` overall because a skipped job
does not fail the run, so the green ✅ on `main` hides the fact that
**not a single Rust release has ever been published**.

## Reader experience (what issue #108 describes)

At the moment issue #108 is filed (2026-04-23):

- `gh release list` shows 30+ entries, all of them `v0.17.1`–`v0.25.4`
  (all JavaScript).
- There is no `rust-*` tag in the repository (`git tag --list "rust-*"`
  returns nothing), yet `rust/Cargo.toml` already sits at version
  `0.14.0` with 17 unreleased changelog fragments in `rust/changelog.d/`.
- There is no `js/README.md` or `rust/README.md`. The top-level
  `README.md` documents only `bun install -g start-command` and carries
  no badges.

## Resolution (PR #109)

1. `scripts/create-github-release.mjs` is taught to read a `--prefix`
   argument and use it both for the tag name (`rust-v0.14.0`) and the
   release title (`[Rust] 0.14.0`).
2. `scripts/format-github-release.mjs` is taught the same, so the
   formatter can find the release it just created.
3. `.github/workflows/rust.yml` gets `always() && !cancelled()` on its
   `auto-release` condition so the job is no longer auto-skipped when
   upstream jobs use `always()`.
4. `js/README.md` and `rust/README.md` are added with per-language
   badges.
5. The root `README.md` is updated to point at the two new READMEs.
6. This case-study folder is created with reproductions, raw data,
   and a solutions write-up.
