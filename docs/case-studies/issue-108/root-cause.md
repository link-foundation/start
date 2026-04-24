# Root-cause analysis — Issue #108

The single user-visible symptom ("there are no Rust releases") has **three**
independent root causes. Each has to be fixed or the surrounding fixes are
ineffective.

---

## Root cause 1 — `auto-release` job is silently skipped

### Evidence

```bash
$ gh api repos/link-foundation/start/actions/runs/24839522582/jobs \
    --jq '.jobs[] | {name, conclusion}'
{"name":"Detect Changes","conclusion":"success"}
{"name":"Lint and Format Check","conclusion":"success"}
{"name":"Test (ubuntu-latest)","conclusion":"success"}
{"name":"Test (macos-latest)","conclusion":"success"}
{"name":"Test (windows-latest)","conclusion":"success"}
{"name":"Build Package","conclusion":"success"}
{"name":"Auto Release","conclusion":"skipped"}      # <-- skipped with 0 steps
{"name":"Manual Release","conclusion":"skipped"}
```

Every `push` to `main` shows the same pattern — `auto-release` is
**skipped**, not failed. Because GitHub Actions marks a workflow green
as long as no job fails, the problem is invisible on the UI.

### Why is it skipped?

Excerpt from the current `.github/workflows/rust.yml`:

```yaml
build:
  name: Build Package
  needs: [lint, test]
  if: always() && github.event_name == 'push' && needs.lint.result == 'success' && needs.test.result == 'success'

auto-release:
  name: Auto Release
  needs: [lint, test, build]
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
```

When a dependency of a job is declared with `if: always()`, GitHub Actions
**propagates the `skipped` status to downstream jobs that do not also
use `always()`** — a long-standing quirk of the runner
(https://github.com/actions/runner/issues/491). The upstream
`rust-ai-driven-development-pipeline-template` already accounts for this:

```yaml
auto-release:
  if: |
    always() && !cancelled() &&
    github.event_name == 'push' &&
    github.ref == 'refs/heads/main' &&
    needs.build.result == 'success'
```

Our workflow was missing the `always() && !cancelled()` guard, so the
runner treated the job as skipped even though all of its dependencies
ran to completion.

### Fix

Port the `always() && !cancelled() && … && needs.build.result == 'success'`
pattern from the template into `rust.yml`. (Done in PR #109.)

---

## Root cause 2 — `--prefix` is silently dropped by the release scripts

### Evidence

```bash
$ grep -n prefix scripts/create-github-release.mjs
(no matches — the flag is never declared as a yargs option)

$ grep -n prefix scripts/format-github-release.mjs
(also no matches)
```

But the workflows call these scripts with a prefix:

```yaml
# js.yml
- run: node scripts/create-github-release.mjs ... --prefix "js-"

# rust.yml
- run: node scripts/create-github-release.mjs ... --prefix "rust-"
```

Because `lino-arguments` / yargs is configured in strict-mode style (only
declared options are exposed on `config`), the `--prefix` value is
parsed but never used. Both scripts hard-code the tag as `v${version}`:

```js
// scripts/create-github-release.mjs:53
const tag = `v${version}`;
```

### Consequence

Even if `auto-release` had run, it would have created a release with
tag `v0.14.0` — which **collides** with the JS release `v0.14.0`. GitHub
would either refuse the creation or produce a confusing duplicate
release, neither of which is what the issue asks for.

### Fix

Teach both scripts to read the optional `--prefix` argument (empty by
default, `js-` for the JS workflow, `rust-` for the Rust workflow) and
use it when constructing:

- the git tag: `${prefix}v${version}`
- the release name: `[JavaScript] ${version}` or `[Rust] ${version}` when
  the prefix corresponds to one of the two known languages; falls back
  to `${version}` for an unknown or empty prefix so that the behaviour
  for generic use is preserved.

(Done in PR #109.)

---

## Root cause 3 — No per-language READMEs, no badges

### Evidence

```bash
$ ls js/README.md rust/README.md
ls: cannot access 'js/README.md': No such file or directory
ls: cannot access 'rust/README.md': No such file or directory

$ grep -E '^\[\!\[' README.md   # any badge lines?
(none)
```

The root `README.md` documents only `bun install -g start-command` and
has no badges at all, while the Rust crate has no entry point document
whatsoever.

### Fix

Add `js/README.md` with npm, GitHub Actions, license, and coverage badges,
and `rust/README.md` with crates.io, docs.rs, GitHub Actions, license,
and coverage badges. Link to both from the root `README.md`.

(Done in PR #109.)

---

## Mismatch with the upstream templates

While comparing `start/.github/workflows/*.yml` with the upstream
templates (`templates/js-template-release.yml`,
`templates/rust-template-release.yml`), these best practices were
observed and adopted where they address an issue affecting this repo:

- **`always() && !cancelled()` gating on `auto-release`** — adopted
  (this is the fix for R-RC1).
- **`needs.build.result == 'success'` guard** — adopted; protects
  against a scenario where `build` is skipped but the job still runs.
- `cargo llvm-cov` for coverage and `cargo package --list --allow-dirty`
  for packaging — **not** adopted in this PR; they are orthogonal to the
  issue and would expand the scope beyond what #108 asks for.
- Publishing to crates.io from the Rust workflow — **not** adopted in
  this PR; the issue only asks for GitHub releases and badges. A
  follow-up issue may be opened to enable crates.io publishing.

The two template repositories release a _single_ language each, so they
don't carry either the prefix bug (Root cause 2) or the missing
per-language READMEs (Root cause 3). No upstream issues need to be filed.
