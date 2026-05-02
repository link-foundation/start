# Root-cause analysis

## RC1 - Rust workflow called modes the release script did not implement

`rust.yml` called `scripts/version-and-commit.mjs` like this:

```yaml
node scripts/version-and-commit.mjs \
--bump-type "${{ steps.bump_type.outputs.bump_type }}" \
--working-dir rust \
--mode changelog
```

The same workflow's manual release path used `--mode manual`.

Before this fix, the script only declared two choices:

```text
choices: "changeset", "instant"
```

The CI log shows the direct failure:

```text
Argument: mode, Given: "changelog", Choices: "changeset", "instant"
```

This prevented Rust versioning, changelog collection, build, and GitHub Release
creation from running.

## RC2 - Rust release automation reused JavaScript package assumptions

The previous `version-and-commit.mjs` read `package.json`, counted `.changeset`
files, and ran `npm run changeset:version`. That is correct for `js/`, but not
for `rust/`, where the version source is `Cargo.toml` and release requests are
stored in `rust/changelog.d/`.

The manual Rust workflow also ran `scripts/collect-changelog.mjs` before
versioning. That collector was hardcoded to read `rust/Cargo.toml` and
`rust/changelog.d` while writing root `CHANGELOG.md`, which would have produced
the wrong changelog location for a language-specific release.

## RC3 - GitHub Release creation read the wrong changelog and matched one format

`scripts/create-github-release.mjs` always read `./CHANGELOG.md` and extracted
entries with a regex shaped around `## <version>`.

That misses both package changelogs:

- JavaScript release notes live in `js/CHANGELOG.md`.
- Rust release notes should live in `rust/CHANGELOG.md` and use
  `## [<version>] - <date>` headings.

The observable result is a fallback release body like `Release 0.26.0` instead
of package-specific release notes.

## RC4 - Badge generation did not normalize language-prefixed tags

The JavaScript formatter received a prefixed release tag from
`format-github-release.mjs`, for example `js-v0.26.0`. Its badge code only
removed a leading `v`, so a prefixed tag could become an invalid static badge
segment and an invalid npm version link.

Rust had no equivalent post-release formatter, so there was no crates.io badge
path in the Rust release flow at all.

## RC5 - Two Windows JavaScript tests had mismatched timeouts

The failing tests did not show application behavior regressions. They showed
test harness timeout mismatches:

- `test/cli.js` allowed the spawned CLI process up to 30 seconds on Windows, but
  the enclosing test still had Node's default 5 second timeout.
- `test/docker-autoremove.js` can spend up to 5 seconds determining whether
  Linux Docker images can run. On Windows, the skip path itself exceeded the
  default 5 second test timeout.

The helper-level timeouts were already longer than the default test timeout, so
the fix is to make the test-level timeout explicit.

## Template comparison

The JavaScript template includes tests and helpers for badge version
normalization with prefixed tags. This repo had the prefix support from issue
#108 but not the exact badge-normalization helper coverage.

The Rust template uses Rust-native release scripts (`version-and-commit.rs`,
`collect-changelog.rs`, `create-github-release.rs`) and does not have this
repository's JS script reuse problem. No matching upstream template issue was
found, so no template issue was filed.
