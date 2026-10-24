# Case Study: Issue #253 - Latest sensitive-data-sanitizer and every other dependency

Issue: <https://github.com/link-foundation/start/issues/253>
Pull request: <https://github.com/link-foundation/start/pull/254>

## Summary

The issue asks for three things. First, a CI rule that fails a pull request when any dependency is not its latest release. Second, a check that the latest `@link-foundation/sensitive-data-sanitizer`, and the other dependencies we control, have every feature start needs, with upstream reports for any gaps. Third, this case study.

Before this pull request, nothing in CI compared a dependency with its latest release. The same checker, run in report mode against `main`, found **131 of 183** declarations stale ([data/freshness-main-before.txt](data/freshness-main-before.txt)). Among them:

- `lino-objects-codec` was five minor releases behind in both languages (JS 0.4.0, Rust 0.2.1).
- `command-stream` was a major release behind (^0.9.4 against 2.4.0).
- The sanitizer was at 0.12.0 against 0.12.1.
- The CI runners, actions and .NET SDK were all old.

After the pull request the same check reports **190 dependencies, 0 stale** ([data/freshness-after.txt](data/freshness-after.txt)).

The upgrades turned up four real defects. Each one is now fixed in start and covered by a test:

1. **The links database had been empty all along.** clink 4.x rejected every query the store sent. The create group had unbalanced parentheses (Rust) or nested groups. Inner quotes were backslash-escaped. Missing references were not created. A quoted `"0"` was read as link address 0. These failures were only logged. The store now writes one record-scoped link per property and verifies with `--changes`. The Rust tests now run against the real clink on Linux. See [Links database](#links-database-clink-402).
2. **`--use-command-stream` lost the command output** with command-stream 2.x. A completed command's stdout and stderr became readable snapshots, which `fs.appendFileSync` rejects. `outputText()` now converts them (`js/test/command-stream-log.js`).
3. **The sanitizer pre-pass was obsolete.** 0.12.1 bounds the `Authorization` header itself (sensitive-data-sanitizer#45). start's own masking pass and its staged copy were removed in JS and Rust, and the log is piped straight into the library.
4. **One NUL byte blocked an upload.** 0.12.1 adds `--allow-binary`, which start now passes. Older sanitizers reject that option, so the Rust binary now checks the version of the sanitizer on `PATH`. It installs 0.12.1 or later when the sanitizer is missing or older.

The review also found gaps in dependencies we control. These were reported upstream (see [Upstream reports](#upstream-reports)):

- sensitive-data-sanitizer#50
- sensitive-data-sanitizer#51
- link-cli#130
- command-stream#235

Files in this folder:

| File                                     | Content                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [requirements.md](requirements.md)       | Every requirement of the issue, with how it is met and the evidence                                     |
| [online-research.md](online-research.md) | Existing tools (Dependabot, Renovate, npm-check-updates, cargo-outdated, ...) and facts gathered online |
| [solutions.md](solutions.md)             | Options per requirement, the chosen plan, and why                                                       |
| [data/](data)                            | Issue text, freshness reports before and after, clink and sanitizer probe output                        |
| [upstream/](upstream)                    | The reports filed upstream, as filed                                                                    |

The scripts that produced the data are in [experiments/issue-253](../../../experiments/issue-253).

## Timeline

All times are UTC.

| Time             | Event                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-08       | gh-upload-log 0.10.1, the last release that reached npm (gh-upload-log#56)                                                   |
| 2026-10-15       | clink 4.0.2 (C#) and link-cli Rust 1.0.5 released; clink now targets .NET 10                                                 |
| 2026-10-23 22:53 | Issue #253 opened                                                                                                            |
| 2026-10-24 01:41 | sensitive-data-sanitizer#49 merged; 0.12.1 published 01:45, fixes #45 (Authorization) and #47 (large logs, `--allow-binary`) |
| 2026-10-24       | This pull request: freshness gate, upgrades, clink store fix, sanitizer simplification, upstream reports                     |

## The dependency freshness gate

`scripts/check-dependency-freshness.mjs` reads every place in the tree that pins a version:

| Ecosystem            | Source                                                                                                                                             | Latest from                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| npm                  | `dependencies`, `devDependencies`, `optionalDependencies`, `overrides` in `js/package.json`; `package-lock.json` and `bun.lock` with `--lockfiles` | registry.npmjs.org `latest` dist-tag                                    |
| crates               | every dependency table of `rust/Cargo.toml`; `Cargo.lock`                                                                                          | crates.io (newest non-yanked stable)                                    |
| GitHub Actions       | `uses:` tags, and commit pins with a `# vX.Y.Z` comment                                                                                            | GitHub releases and tags                                                |
| CI tools             | `npx -p`, `pip ==`, `tool:`, `cargo install --version`, the actionlint release                                                                     | npm, PyPI, crates.io, GitHub releases                                   |
| Runtimes and runners | `node-version`, `bun-version`, `dotnet-version`, `runs-on`                                                                                         | Node.js and .NET release indexes, Bun releases, `actions/runner-images` |
| Translator           | `parity/translation.json` revision of meta-language                                                                                                | `main` HEAD of the repository                                           |

A declaration counts as fresh only when its **lower bound** is the latest stable release:

- `^0.12.0` is stale once 0.12.1 exists, even though the range already admits 0.12.1. The floor is what a fresh install of an older lockfile can still resolve, and what readers take as the supported version.
- A new major release is stale too. That is how command-stream 0.9 → 2.4 and dirs 6 → 7 were found.

A dependency that cannot move yet needs a blocker: a link to an **open** GitHub issue. The link goes in a comment on the same line (YAML, TOML, scripts) or, for JSON manifests, in `.github/dependency-blockers.json`. A closed blocker fails the check, so blockers cannot outlive their reason. None are needed today.

How CI runs it:

- **js.yml** has a `Dependency Freshness` job. It runs the check with `--lockfiles` on pull requests, so both JavaScript lockfiles must already hold the newest versions the ranges allow, transitive ones included. Elsewhere it adds `--report`, which lists stale entries without failing, so a release published after a merge cannot block the release of `main`.
- **rust.yml**'s lint job runs `cargo update --dry-run` on pull requests and fails if Cargo.lock would change. Cargo stays inside the Rust stage, as `scripts/check-javascript-first.mjs` requires.
- `js/test/dependency-freshness.mjs` tests the parser and the policy against fixtures: stale floors, blockers, closed blockers, commit pins without a version comment, unreachable registries and lockfiles.

`actionlint` 1.7.12, the latest release, does not know the `ubuntu-26.04` label yet (rhysd/actionlint#682). `.github/actionlint.yaml` declares it as a known label until a release does.

## What the upgrades changed

### sensitive-data-sanitizer 0.12.0 → 0.12.1

| Need of start                                                              | 0.12.0                                                    | 0.12.1                                  | start now                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------- | ------------------------------ |
| Mask only the scheme and token of `Authorization: <scheme> <token>` (#249) | masked to the end of the line (#45)                       | bounded                                 | pre-pass removed (JS and Rust) |
| A NUL byte in a terminal transcript                                        | `ERR_BINARY`, upload blocked (#47)                        | `--allow-binary` keeps it as a log byte | passes `--allow-binary`        |
| Large logs in file mode                                                    | `ERR_WORKER` at 60 s (#47)                                | streamed, `--worker-timeout-ms`         | uses `--stream`                |
| Masking `AUTH`-named configuration values (#46)                            | `GIT_AUTH_TRANSPORT=github.com` masked every `github.com` | fixed                                   | covered by the shared tests    |

The Rust binary installs the CLI with Bun or npm. A `sensitive-data-sanitizer` already on `PATH` may be older, and 0.12.0 rejects `--allow-binary` with `ERR_ARGUMENT`. `ensure_sanitizer_available` therefore:

1. runs `--version`;
2. installs `@link-foundation/sensitive-data-sanitizer@^0.12.1` when the sanitizer is missing or older;
3. blocks the upload with a value-free code if no current sanitizer is available after that.

`requires_the_sanitizer_release_the_javascript_package_bundles` (Rust) and "requires the sanitizer release the Rust installer asks for" (JS) fail if the two implementations ever ask for different releases.

Some cases are still wrong in 0.12.1 and are reported upstream (#50, #51). They lose no secrets:

| Input                                      | 0.12.1 output                                        |
| ------------------------------------------ | ---------------------------------------------------- |
| `Authorization: Bearer [REDACTED] already` | `Authorization: [REDACTED]] already`                 |
| `Authorization: Bearer {{token}} x`        | `Authorization: [REDACTED]}} x`                      |
| `Authorization: Bearer abc\0 tail`         | `Authorization: [REDACTED] tail` (NUL lost)          |
| 256 KiB of `ghp_` tokens                   | 72 s; 64 KiB of SHAs, base64 or UUIDs take about 1 s |

The recorded output is in [data/sanitizer-findings-0.12.1.txt](data/sanitizer-findings-0.12.1.txt).

**A lesson from the change: a mocked failure can still publish.** The old failure test mocked `fs.readSync` to fail, and it relied on the in-process pre-pass reading the log. Once the library read the log itself, the mock no longer triggered, and the test uploaded two real secret gists holding the text "ordinary log". Both were deleted. The test now injects `openSync`/`fstatSync` failures, the only file access left in-process. It also puts a fake `gh-upload-log` on `PATH` and asserts that the fake never ran, so a future regression cannot publish anything.

### lino-objects-codec (JS 0.4.0 → 0.9.3, Rust 0.2.1 → 0.9.2)

- 0.9 writes readable links notation instead of base64 (`uuid "…"`, single-quoted multi-line strings, `null`, `true`, numbers).
- It still decodes stores written by 0.4.0. Both implementations read both fixtures: `js/test/fixtures/executions-lino-objects-codec-{0.4.0,0.9.3}.lino`, `rust/tests/regression_253.rs`.
- The JS and Rust encoders produce byte-identical output.
- **Older releases of start cannot read a store written by this one.** The changelog says so.
- A round-trip fuzz over quotes, newlines, Unicode, NUL, `$(...)` and numbers found no mismatch under Node.js or Bun.
- The vendored copy under `lib/lino-objects-codec` was built by nothing, but CodeQL scanned it and it pinned old dependencies. It was removed.

### command-stream 0.9.4 → 2.4.0

- 2.x returns completed stdout and stderr as readable snapshots. `outputText()` converts them before they are appended to the log.
- 2.4.0 adds `@resvg/resvg-js` (8.5 MB native), `@xterm/headless` (1.9 MB), `execa` and the optional `node-pty` (63 MB). With them, command-stream takes about 79 MB of `js/node_modules`.
- `import { $ }` now loads 281 modules and takes about 350 ms (command-stream#235).
- start imports command-stream lazily, only for `--use-command-stream`, so its startup time is unaffected.

### Links database (clink 4.0.2)

clink 4.0.2 targets .NET 10, so CI's .NET 8 could not run it. The probes in [data/clink-queries-4.0.2.txt](data/clink-queries-4.0.2.txt) show why the store never wrote anything:

| Query shape (start ≤ 0.39.2)                             | clink 4.0.2                                                |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| nested groups without `--auto-create-missing-references` | `Invalid reference to non-existent link 'ExecutionRecord'` |
| `"{\"a\":1}"` (backslash-escaped JSON)                   | `Parse error … unexpected ":"`                             |
| `exitCode "0"`                                           | `Cannot ensure unsupported link address 0`                 |
| `(status executing)` shared by two records               | the second record takes over the name                      |

The new schema is:

- a record link `(uuid: ExecutionRecord uuid)`;
- one record-scoped link per property, `(uuid.key: uuid "key=value")`, so no value is a bare number and no two records share a link;
- updates delete the record's property links and create the new ones;
- verification passes `--changes`, so the read-only match prints its links.

`js/test/execution-store-clink.js` and the Rust tests run this against the real clink.

### CI, runners and runtimes

| Item                     | Before                                     | After                                      |
| ------------------------ | ------------------------------------------ | ------------------------------------------ |
| `actions/checkout`       | v6                                         | v7                                         |
| `actions/setup-node`     | v6                                         | v7                                         |
| `actions/cache`          | v5                                         | v6                                         |
| `actions/setup-dotnet`   | v5                                         | v6                                         |
| .NET SDK                 | 8.0.x                                      | 10.0.x                                     |
| Runners                  | `ubuntu-24.04`, `macos-15`, `windows-2025` | `ubuntu-26.04`, `macos-26`, `windows-2025` |
| zizmor-action            | v0.6.4                                     | v0.8.0                                     |
| `taiki-e/install-action` | v2.87.4                                    | v2.87.31                                   |
| `dtolnay/rust-toolchain` | `master` @ 2026-10-09                      | `master` @ 2026-10-24                      |
| `crates-io-auth-action`  | v1.0.5                                     | v1.0.6                                     |
| pyflakes                 | 3.4.0                                      | 4.0.3                                      |
| `setup-bun`              | commit pin without a version comment       | `# v2.2.0` comment added                   |

The Rust test job installs clink on Linux too.

### Other dependencies

- **JavaScript dev tools:** eslint 10.13, prettier 3.9.10, lint-staged 17.6, eslint-plugin-prettier 5.5.7, flatted 3.4.4. The `js-yaml` override was removed because nothing resolves `js-yaml` any more.
- **Rust crates:** chrono 0.4.45, dirs 7, regex 1.13, serde 1.0.229, serde_json 1.0.154, uuid 1.29, sha2 0.11, libc 0.2.191, tempfile 3.27.
- **meta-language translator:** pinned to its `main` HEAD. A pin bump can now regenerate the Rust code without a JavaScript change.
- **gh-upload-log** is installed at run time without a version (`bun install -g gh-upload-log`), so it gets the newest published release, 0.10.1. start only calls `gh-upload-log <file> --private`, which every release supports.
  - Upstream renamed the package to `gh-upload-file`, but no release after 0.10.1 has reached npm (gh-upload-log#56, open; it needs the npm account owner).
  - **Blocked:** start can switch to `gh-upload-file` only after that package is published. Until then, `gh-upload-log` 0.10.1 is the latest release that exists.

## Upstream reports

| Repository               | Issue                                                                        | Finding                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| sensitive-data-sanitizer | [#50](https://github.com/link-foundation/sensitive-data-sanitizer/issues/50) | Authorization token ends at `]`/`}` and swallows a following NUL; re-sanitizing is not idempotent |
| sensitive-data-sanitizer | [#51](https://github.com/link-foundation/sensitive-data-sanitizer/issues/51) | Dense credentials take quadratic time: each re2-wasm `exec` copies the whole view                 |
| link-cli                 | [#130](https://github.com/link-foundation/link-cli/issues/130)               | A quoted number in a query is read as a link address                                              |
| command-stream           | [#235](https://github.com/link-foundation/command-stream/issues/235)         | `import { $ }` loads 281 modules and takes about 350 ms                                           |

These already-open issues cover other things we hit, so no new reports were filed for them:

- link-cli#128: `--import` drops backslashes.
- link-cli#129: `--import` is not atomic.
- gh-upload-log#56: releases are blocked since the rename.
- gh-upload-log#55: gh-upload-log does not sanitize by itself.
- rhysd/actionlint#682: the `ubuntu-26.04` label is unknown.

## Verification

- JavaScript: `cd js && bun run check && bun run test`, 1567 pass and 0 fail.
- Rust: `cargo clippy --all-targets --all-features -- -D warnings` and `cargo fmt --check` are clean. All 71 test binaries pass, including the clink and minimum-version tests.
- Freshness: `node scripts/check-dependency-freshness.mjs --lockfiles` reports 190 dependencies, 0 stale.
- Parity: `scripts/check-feature-parity.mjs` and `scripts/check-test-parity.mjs` pass.
