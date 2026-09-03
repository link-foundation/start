# Issue #168 — deep analysis

**Issue:** [link-foundation/start#168](https://github.com/link-foundation/start/issues/168) —
"Check for all false positives, false negatives, warnings and errors in CI/CD and fix them all"
**Pull request:** [#169](https://github.com/link-foundation/start/pull/169)
**Broken commit under investigation:** `23dd3ed3fa27d4723e16ba4e1aa5428d028882d3` on `main`

All evidence referenced below lives in this folder:

| Path | Contents |
| --- | --- |
| `ci-logs/rust-33746569750.log` | full log of the failing Rust CI/CD run (9740 lines) |
| `ci-logs/js-33746569769.log` | full log of the failing JavaScript CI/CD run (8963 lines) |
| `ci-logs/js-release.log`, `ci-logs/rust-auto-release.log` | isolated logs of the two failing jobs |
| `ci-logs/run-337346808*.log`, `ci-logs/run-337408153*.log` | the two earlier failing pushes of the same day |
| `ci-logs/security-33746569727.log`, `ci-logs/links-33746569561.log` | the two *green* runs of the same commit |
| `ci-logs/*-jobs.json` | per-job status/timing for the two failing runs |
| `runs-main.json` | every workflow run recorded on `main` |
| `CI-CD-BEST-PRACTICES.md` | snapshot of the hive-mind best-practices document the issue links to |
| `templates/{js,rust,python}/.github/**` | snapshot of the three CI/CD templates |
| `analysis/actionlint-{before,after}.txt` | workflow lint output before/after this PR |
| `analysis/zizmor-{before,after}.txt` | workflow security audit before/after this PR |

---

## 1. Timeline of events

Reconstructed from `runs-main.json` and the job logs.

| When (UTC) | Commit | Event |
| --- | --- | --- |
| 2026-08-10 17:40:12 | `267760ff` | **Last fully green `main`.** JavaScript CI/CD `31415173827`, Rust CI/CD `31415173970`, Security `31415173837`, Links `31415173894` — all `success`. |
| 2026-08-17 … 08-31 | `013a4c84` | Only the weekly scheduled Security runs execute (`32004480345`, `32700414043`, `33396873879`) — all green. No push to `main`, so the release jobs never run. |
| 2026-09-02 ~08:30 | — | `use-m` **8.15.1** is published to npm. Every release script resolves `use-m` at run time from `https://unpkg.com/use-m/use.js`, i.e. *unpinned*, so this version is picked up on the next CI run without any repository change. |
| 2026-09-03 08:41:05 | `7cadb78f` | First push after the gap. JavaScript CI/CD `33734680882` **fails**, Rust CI/CD `33734680890` **fails**. Security and Links stay green. |
| 2026-09-03 09:47:45 | `4efbc780` | Same two failures (`33740815350`, `33740815303`). |
| 2026-09-03 10:51:43 | `23dd3ed3` | Same two failures (`33746569769`, `33746569750`) — the runs quoted in the issue. |

The failure is therefore **not** caused by any commit in the repository: the tree
that failed on 2026-09-03 differs from the tree that passed on 2026-08-10 only in
documentation and Rust refactoring, and the *same* commit passes the Security and
Broken Link Checker workflows. The change came from outside the repository.

### The exact failure

`ci-logs/js-33746569769.log:8725`:

```
Release  2026-09-03T10:53:26.4160871Z Error updating npm: $ is not a function
Release  2026-09-03T10:53:26.4235695Z ##[error]Process completed with exit code 1.
```

`ci-logs/rust-33746569750.log:9490`:

```
Auto Release  2026-09-03T10:55:06.6614698Z Error: $ is not a function
```

Both are the *first* `$`` `` template literal executed by the release scripts
(`scripts/setup-npm.mjs` for JS, `scripts/version-and-commit.mjs` for Rust).

---

## 2. Root causes

### RC-1 — `use-m` returns a raw CJS namespace on Node ≥ 22.12 (the run-breaking bug)

Every release script used this pattern:

```js
const { use } = eval(await (await fetch('https://unpkg.com/use-m/use.js')).text());
const { $ } = await use('command-stream');   // <- $ is undefined on Node 24
```

`use-m`'s `baseUse` unwraps the CommonJS default export only when the
`import()` namespace has no *meaningful* named exports — either exactly one key
`default`, or no key outside a hard-coded `metadataKeys` allow-list
(`upstream/use-m-8.15.1-use.js:1367`):

```js
const metadataKeys = new Set([
  'default', '__esModule', 'Symbol(Symbol.toStringTag)',
  'length', 'name', 'prototype', 'constructor',
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'
]);
const nonMetadataKeys = keys.filter(key => !metadataKeys.has(key));
if (nonMetadataKeys.length === 0) { return module.default; }
```

Node ≥ 22.12 adds a synthetic `'module.exports'` named export to a CommonJS
namespace whose exports `cjs-module-lexer` cannot statically analyse.
`command-stream`'s `src/$.cjs` assigns its exports dynamically, so the namespace
becomes `[Module] { default, 'module.exports' }`. `'module.exports'` is not in
`metadataKeys`, so `nonMetadataKeys.length === 1`, `use-m` returns the raw
namespace, and `const { $ } = …` destructures `undefined`. The upstream fix is a
single added entry in that set — see §5.

Reproduced locally, `experiments/issue-168-use-m-cjs-interop.mjs`:

```
Node v20.20.2 -> keys: [ 'default' ]                       typeof loaded.$ : function
Node v24.19.0 -> keys: [ 'default', 'module.exports' ]     typeof loaded.$ : undefined
                                                            typeof resolved.$ : function
                                                            command output  : issue-168-ok
```

The release jobs run on Node `24.x`; the last green run predates the `use-m`
release that made the namespace shape observable. This is a genuine **error**,
and it is also a **false negative** of the test suite: nothing exercised the
release scripts' module loading, so CI only discovered the breakage on `main`,
after merge, in a job that pushes tags.

### RC-2 — the workflows themselves were never linted (false negatives)

There was no workflow-lint job at all. Running the standard tools for the first
time (`analysis/*-before.txt`):

* **actionlint 1.7.7** — 2 errors: `github.head_ref` interpolated directly into
  `run:` blocks (`js.yml:146`, `js.yml:202`) — template injection. A further
  **7 shellcheck findings** surfaced only in CI: the `rhysd/actionlint` Docker
  image bundles shellcheck, a bare local binary does not, so the first local
  run reported 0 — a false negative in the verification itself. They were
  reproduced locally by putting shellcheck on `PATH` and fixed:
  4 × SC2086 (unquoted `$GITHUB_PATH` / `$GITHUB_OUTPUT` redirections in
  `js.yml:331,529` and `rust.yml:430,565`) and 2 × SC2126
  (`grep … | wc -l` → `grep -c`, `rust.yml:191`).
* **zizmor 1.30.0** — **27 high-confidence/high-severity findings**:
  9 × `template-injection`, unpinned third-party actions
  (`dtolnay/rust-toolchain@stable`, `oven-sh/setup-bun`,
  `peter-evans/create-pull-request@v7`), and `artipacked` — 24 checkouts that
  persisted the `GITHUB_TOKEN` in `.git/config` although the job only reads.

### RC-3 — dependency graphs were never audited (false negatives)

The Security workflow ran CodeQL, dependency-review and secret scanning but
never `cargo audit` or `npm audit`. Two **high-severity** advisories were sitting
undetected in `js/package-lock.json`. `cargo audit` on `rust/Cargo.lock` is
clean (71 crates, 1239 advisories loaded).

### RC-4 — `scripts/` was excluded from ESLint and Prettier (false negative)

`js/eslint.config.mjs` has `js/` as its ESLint base path, and CI ran `eslint .`
with `working-directory: js`. ESLint 9+ refuses to lint files outside the config
base path, so **the entire repository-level `scripts/` directory — the release
automation, i.e. exactly the code that broke — was silently skipped.** Linting it
for the first time produced 615 issues, three of them real defects:

| File | Defect |
| --- | --- |
| `scripts/check-web-archive.mjs:92` | `AbortController is not defined` |
| `scripts/publish-to-crates.mjs:139` | `setTimeout is not defined` |
| `scripts/verify-release-badge.mjs:74` | `Unnecessary escape character: \!` in a regex |

### RC-5 — unpinned remote code execution (systemic risk, not yet a failure)

`eval(await (await fetch('https://unpkg.com/use-m/use.js')).text())` executes
whatever unpkg serves at that moment, on a runner that holds `contents: write`
and npm/crates publishing credentials. RC-1 is the benign manifestation of this;
the malicious one is a supply-chain compromise of the `use-m` npm package.
Out of scope for this PR (the pattern comes from the upstream templates), but
recorded here as the highest-value follow-up: see §5.

---

## 3. Requirements extracted from the issue

| # | Requirement (verbatim intent) | Status |
| --- | --- | --- |
| **R1** | Fix the failing Rust CI/CD run `33746569750` | ✅ RC-1 fixed |
| **R2** | Fix the failing JavaScript CI/CD run `33746569769` | ✅ RC-1 fixed |
| **R3** | Find **all** false positives in CI/CD | ✅ see §4 (workflows) and §7 (code scanning: 1 excluded path, 9 documented) |
| **R4** | Find **all** false negatives in CI/CD | ✅ RC-2, RC-3, RC-4 |
| **R5** | Find and fix **all** warnings and errors | ✅ actionlint 0, zizmor 0, eslint/prettier 0, audits 0, code-scanning alerts §7 |
| **R6** | Compare the **full file tree** with the three templates and reuse every best practice | ✅ see §4 |
| **R7** | Report the same issue upstream in the templates when found there | ✅ see §5 |
| **R8** | Follow `link-assistant/hive-mind` `docs/CI-CD-BEST-PRACTICES.md` | ✅ see §4 |
| **R9** | Do everything in the single PR #169 | ✅ |
| **R10** | Add debug output / verbose mode, default off, when data is insufficient | ✅ `scripts/load-command-stream.mjs` uses the existing `START_DEBUG` gate |
| **R11** | Apply each fix in *every* place it occurs, not just the first | ✅ all 8 affected scripts, all 5 workflows, and every code-scanning alert in **both** runtimes (§7) |

---

## 4. What was changed, per requirement

### R1/R2 — `scripts/load-command-stream.mjs`

A single shared loader replaces the fragile destructuring in **all eight**
scripts that used it (`setup-npm`, `version-and-commit`, `create-manual-changeset`,
`instant-version-bump`, `publish-to-npm`, `format-github-release`,
`changeset-version`, `format-release-notes`):

```js
const { $ } = await loadCommandStream(use);
```

`resolveNamedExport()` tries, in order, `loaded`, `loaded.default`,
`loaded['module.exports']` and `loaded.default.default`, returning the first
candidate that carries a callable member. If none does it throws an *actionable*
error naming the keys actually observed, instead of the opaque
`$ is not a function`. Debug output is gated behind the repository's existing
`START_DEBUG` / `RUNNER_DEBUG` / `ACTIONS_STEP_DEBUG` convention
(`scripts/debug-print.mjs`) and is **off by default** (R10).

Regression coverage: `js/test/load-command-stream.mjs`, 8 tests, including the
Node-24 namespace shape that caused the outage and the error-message contract.

### R3 — false positives

None were found. Two candidates were examined and **deliberately left alone**:

* `pipeline-status` uses `if: always()`, not `if: !cancelled()`. Changing it to
  `!cancelled()` looks like a cleanup but would *hide* failures: a job killed by
  `timeout-minutes` is reported as `cancelled`, and the gate must still fail the
  run. The repository's own invariant tests
  (`js/test/ci-workflow-invariants.js`, `rust/tests/ci_workflow_invariants.rs`)
  encode this on purpose; an attempted change was reverted.
* `npm audit` fails locally with `ENOLOCK` when `node_modules` was installed by
  bun. Verified in a clean copy (`/tmp/auditcheck`) that this is a local-only
  artefact — the CI job runs on a fresh checkout with no install — so the job is
  correct.

### R4/R5 — new gates

* **`.github/workflows/workflows.yml`** (from the templates): `actionlint`
  (`docker://rhysd/actionlint:1.7.7`) + `zizmor`
  (`zizmorcore/zizmor-action@v0.6.2`), both feeding a `pipeline-status` gate.
* **`.github/zizmor.yml`**: `hash-pin` blanket policy with `ref-pin` for the
  trusted first-party namespaces.
* **`.github/actionlint.yaml`**: declares the `macos-15-intel` /
  `windows-11-arm` runner labels.
* 9 template-injection sites moved to `env:` variables (5 in `js.yml`,
  4 in `rust.yml`).
* Third-party actions hash-pinned: 6 × `oven-sh/setup-bun`,
  `peter-evans/create-pull-request` v7 → v8.1.1,
  6 × `dtolnay/rust-toolchain` (note: the pin targets the `stable` *branch*
  head, so `toolchain: stable` must be restated explicitly — the branch was
  what supplied that default).
* `persist-credentials: false` on all 24 read-only checkouts; the writer
  checkouts keep credentials and carry a comment explaining why.
* **`cargo-audit`** and **`npm-audit`** jobs added to `security.yml`.
* Root `eslint.config.mjs` / `.prettierrc` / `.prettierignore` re-export the
  `js/` rules with the repository as base path, plus `lint:scripts` and
  `format:check:scripts` npm scripts wired into `bun run check` and into the
  `js.yml` lint job — closing RC-4.

One further false negative appeared on the first CI run of the new job: the
`zizmor-action` defaults to `inputs: .`, so it audited the **template snapshots
archived under `dev/log/`** — other projects' workflows — and failed the build
on their findings. The job now passes `inputs: .github/workflows`; those
findings are reported in the templates' own repositories instead (§5).

A third false positive came from this repository's own tooling:
`scripts/check-file-size.mjs` enforces a 1000-line refactoring limit over the
whole tree, so the archived third-party snapshot
`dev/log/.../upstream/use-m-8.15.1-use.js` (1575 lines) failed both the
JavaScript and the Rust `lint` job. The archive cannot be refactored without
destroying the evidence it preserves, so `dev/log` joins `node_modules`,
`target` and friends in the checker's exclusion list - the same boundary
`eslint.config.mjs` and `.prettierignore` already draw. Covered by
`js/test/check-file-size.js` and `rust/tests/check_file_size.rs`.

The first version of that exemption was itself platform-dependent: the checker
matched and reported `relative()` output verbatim, which is `dev\log` on
Windows, so the Bun-on-`windows-latest` matrix leg failed while Linux passed.
Paths are now normalised to forward slashes before both matching and reporting.

**Result:** `analysis/actionlint-after.txt` is empty (exit 0);
`analysis/zizmor-after.txt` ends with `No findings to report. Good job!`;
`bun run check` and the full test suite pass; `cargo audit` and
`npm audit --audit-level=high` report zero vulnerabilities.

### R6/R8 — template and best-practice comparison

Full trees of the three templates are snapshotted under `templates/`. Practices
adopted here that the repository was missing: the `workflows.yml` lint workflow,
`.github/zizmor.yml`, `.github/actionlint.yaml`, hash-pinning,
`persist-credentials: false`, and the dependency-audit jobs. Practices the
repository already had, matching the hive-mind document: per-job `concurrency`
(cancellable `check-*` groups vs a non-cancellable
`main-writer-${{ github.repository }}-main` group for the writers), explicit
`permissions:` on every job, `timeout-minutes` on every job, and the
`pipeline-status` aggregate gate.

Gaps in the **templates** relative to this repository (worth upstreaming the
other way): the templates have no JS↔Rust test-count parity gate, no
`check-file-size` gate, and no structural workflow-invariant tests.

---

## 5. Upstream reports (R7)

All three template repositories and the root-cause library were checked; in two
cases a report already existed, so the finding was added there rather than
duplicated.

| Project | Finding | Report |
| --- | --- | --- |
| `link-foundation/use-m` | `baseUse`'s `metadataKeys` set omits Node's synthetic `'module.exports'` CommonJS-namespace marker, so the callable default is never unwrapped on Node ≥ 22.12 | issue [#72](https://github.com/link-foundation/use-m/issues/72) already existed (opened 2026-08-11, still open). Added [comment 5530591308](https://github.com/link-foundation/use-m/issues/72#issuecomment-5530591308) with this incident, the Node 20 vs 24 reproduction, the exact source location (`use.js:1367`), a one-line diff adding `'module.exports'` to `metadataKeys`, and the workaround. |
| `link-foundation/js-ai-driven-development-pipeline-template` | ships the same `const { $ } = await use('command-stream')` in **8** scripts | issue [#151](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/151) had been **closed as completed on 2026-09-02 by PR #152, which changed only `.gitkeep`** — a false fix; the 8 call sites are untouched in `main`. Added [comment 5530595214](https://github.com/link-foundation/js-ai-driven-development-pipeline-template/issues/151#issuecomment-5530595214) with that evidence and **reopened the issue**, including a suggested acceptance criterion (a test that loads `command-stream` through `use-m` on Node 24) so it cannot be closed again without a fix. |
| `link-foundation/rust-ai-driven-development-pipeline-template` | `workflows.yml` runs `actionlint` but not `zizmor`; no `.github/zizmor.yml`; **10** unpinned `dtolnay/rust-toolchain@stable`; no `persist-credentials: false` | new issue [#147](https://github.com/link-foundation/rust-ai-driven-development-pipeline-template/issues/147) |
| `link-foundation/python-ai-driven-development-pipeline-template` | same missing `zizmor` gate; **17** checkouts and **zero** `persist-credentials`; `pypa/gh-action-pypi-publish@release/v1` pinned to a mutable branch in the PyPI publish job | new issue [#64](https://github.com/link-foundation/python-ai-driven-development-pipeline-template/issues/64) |

Each report contains a runnable reproduction, the workaround shipped here, and a
concrete code-level fix. The Rust and Python templates do not use
`command-stream`, so RC-1 does not affect them.

A snapshot of the published `use-m` bundle the failing runs executed is kept at
`upstream/use-m-8.15.1-use.js` — the CDN URL is unpinned, so it will not stay
reproducible otherwise.

## 6. Existing components/libraries surveyed

* **actionlint** (`rhysd/actionlint`) — adopted; the de-facto workflow linter,
  bundles shellcheck/pyflakes for `run:` blocks.
* **zizmor** (`zizmorcore/zizmor`) — adopted; static security audit for
  workflows (template injection, credential persistence, unpinned actions).
* **`cargo-audit`** (RustSec) and **`npm audit`** — adopted for dependency
  advisories; `cargo-deny` was considered but overlaps `cargo audit` and adds
  license policy this repository does not need.
* **`pinact` / `ratchet`** — action hash-pinning automation. Not adopted: with
  five workflows the pins are maintainable by hand, and zizmor already fails the
  build if one regresses.
* **`esm-cjs` interop helpers** — no maintained library does exactly what
  `resolveNamedExport` does (probing the Node ≥ 22.12 `'module.exports'` key);
  the ~30-line local helper with a test suite is the smaller dependency.

---

## 7. Code scanning (CodeQL) — every open alert

The check the issue reports as failing is **`CodeQL`** — the aggregate
`github-advanced-security` check-run, not the per-language workflow jobs (those
were green throughout). That check-run fails a pull request when code-scanning
reports a *new* alert in code the pull request changed, which is why it is
invisible in the workflow logs under `ci-logs/`.

Snapshot of the state before this work: `analysis/codeql-annotations.json` (the
two alerts that failed the check), `analysis/codeql-alerts-branch.json`, and
`analysis/codeql-alerts-all-open.{json,tsv}` (all 25 open alerts, so the backlog
could be triaged rather than only the two blocking ones).

### 7.1 The two alerts that failed the check

| Alert | Rule | Location | Root cause | Fix |
| --- | --- | --- | --- | --- |
| — | `js/redos` | `dev/log/.../upstream/use-m-8.15.1-use.js` | `dev/log/` archives **third-party** evidence verbatim; the vendored `use-m` bundle contains a polynomial-backtracking regex. Editing archived evidence would destroy the evidence. | `.github/codeql/codeql-config.yml` with `paths-ignore: dev/log`, wired into `github/codeql-action/init@v4` via `config-file:`. This mirrors the boundary `eslint.config.mjs`, `.prettierignore` and `scripts/check-file-size.mjs` already draw. The finding belongs upstream, in `use-m`. |
| — | `js/incomplete-url-substring-sanitization` | `scripts/format-release-notes.mjs` | `currentBody.includes('img.shields.io')` — a substring test that also matches `https://example.invalid/img.shields.io` or `?u=img.shields.io`. | `containsPackageVersionBadge()` in `scripts/release-name.mjs` parses every markdown image target with `new URL()` and compares `url.hostname` exactly. 5 unit tests, including the three look-alike URLs. |

An invariant test in **both** runtimes
(`js/test/ci-workflow-invariants.js`, `rust/tests/ci_workflow_invariants.rs`)
asserts the `codeql` job still passes `config-file:` and that the file still
excludes `dev/log`, so the exclusion cannot silently disappear.

### 7.2 The pre-existing backlog

The issue asks for *all* problems, not only the blocking ones, so the remaining
23 open alerts were triaged. Every alert had a real defect behind it.

| Alerts | Rule | Root cause | Fix |
| --- | --- | --- | --- |
| #2, #40 | `js/insecure-randomness` | `generateUUID()` fell back to `Math.random()`, and `generateIsolatedUsername()` built its suffix from `Math.random().toString(36)`. Isolation usernames and session ids are collision- and guess-sensitive. | `crypto.randomUUID` / `crypto.randomBytes(16)` (v4 bits set explicitly) and `crypto.randomInt(36)`. The Rust mirror had the **same defect as a false negative** — a time-seeded xorshift `simple_random()` that no CodeQL query flags — replaced by `Uuid::new_v4()` bytes with rejection sampling for a uniform base36 alphabet. |
| #3, #4 | `js/shell-command-injection-from-environment` | `failure-handler` ran `which/where`, `npm view`, `npm root -g`, `gh …` and `gh-upload-log "$path"` through a shell with the failing command's own name interpolated into the string. | All spawned with `execFileSync(cmd, [argv…])`. |
| #6, #7, #9 | `js/shell-command-constructed-from-input` | Sources feeding `execClink`. | Resolved with #8. |
| #8 | `js/shell-command-constructed-from-input` | `execClink` built `clink '<query>' --db "<path>"`; the query embeds recorded command text, so a single quote in any recorded command escaped the quoting. | `execFileSync('clink', [query, '--db', this.linksDbPath])`, plus a regression test that drives the real code path through a fake `clink` on `PATH` and asserts on the recorded argv. |
| #15, #16 | `js/incomplete-sanitization` | `createIssue` escaped only `"` before interpolating the title and body into a `gh issue create …` shell string. Two real bugs: a backtick or `$(…)` in the failing command was **executed**, and `body.replace(/\n/g,'\\n')` sent every newline to GitHub as the two characters `\n`. | `execFileSync('gh', ['issue','create',…])`. The Rust mirror never used a shell, so its identical escaping only corrupted the issue text — removed. |
| #17 | `js/incomplete-sanitization` | `scripts/version-and-commit.mjs` escaped `"` into a command-stream template that already quotes interpolated values. | Escaping removed. |
| #11 | `js/incomplete-url-substring-sanitization` | `bugsUrl.includes('github.com')` before `parseGitUrl`. | Dropped: `parseGitUrl` / `parse_git_url` anchor on the `github.com` host themselves. Applied in both runtimes. |
| #12 | `js/incomplete-url-substring-sanitization` | A test asserted `message.includes('https://docs.docker.com/get-docker/')`. | Extract the URL and compare it whole — a strictly stronger assertion. |
| #10 | `js/unnecessary-use-of-cat` | `execSync(\`cat ${logFile}\`)` in an experiment. | `fs.readFileSync`. |
| #14 | `js/incomplete-sanitization` | An experiment escaped `"` without escaping `\\` first, so a trailing backslash escapes the quote it just added. | `.replace(/(["\\])/g, '\\$1')`. |

Each fix is covered by a regression test that was **mutation-verified**: the
test was run against the previous implementation and observed to fail.

### 7.3 `rust/cleartext-logging` (10 alerts: 5 fixed, 5 false positives)

| Alerts | Location | Value |
| --- | --- | --- |
| #23, #25 | `rust/src/bin/main.rs:447,658` | `execution_record.uuid` |
| #24, #28 | `rust/src/bin/main.rs:344,541` | generated isolation `username` |
| #26 | `rust/src/lib/execution_store.rs:379` | `record.uuid` |
| #18–#21, #43 | `rust/tests/{user_manager,utils}.rs` | test assertions interpolating the same two values into their failure messages |

**#18–#21 and #43 are fixed.** Alert #43 (`rust/tests/user_manager.rs:92`,
high severity) was raised on a line *this* pull request added, so unlike the
rest of the backlog it gated the `CodeQL` check-run. A test assertion has no
diagnostic need for the value: every one of these assertions is about the
*shape* of the generated name or UUID — a prefix, a character class, a
hyphen-separated part count — so the message now states the expectation and
omits the value. The four pre-existing sibling alerts in the same two files
were given the same treatment, per "if an issue exists in multiple places,
apply it in all of them".

The five remaining alerts, all in `src/`, are **false positives**. The query treats a value derived from a random
source as credential-like, but a session UUID and an isolation username are the
handles the user needs in order to `--attach`, `--resume` or `--status` a run;
printing them is the feature. They are neither secret nor sensitive, and nothing
authenticates on them.

They are *not* suppressed in code: renaming variables to dodge the query's
heuristic would be gaming it, and excluding `rust/cleartext-logging` in
`codeql-config.yml` would suppress the rule repository-wide, including future
genuine findings. The correct mechanism is a per-alert **"Dismiss → False
positive"** in the repository's Security tab, which is a change to repository
state rather than to this pull request, and is left for a maintainer. None of
these alerts gate the pull request: the `CodeQL` check-run only fails on alerts
in code the pull request changed.
