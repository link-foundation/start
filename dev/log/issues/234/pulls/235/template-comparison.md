# Issue #234: CI/CD compared with the upstream pipeline templates

This report compares this repository's CI/CD with the three upstream pipeline templates and with
`CI-CD-BEST-PRACTICES.md`. It looks for causes of false positives, false negatives, warnings and errors.

| Template | HEAD | Date |
|---|---|---|
| js-ai-driven-development-pipeline-template | `0a62b80544ad` | 2026-10-10T18:47:47+07:00 |
| rust-ai-driven-development-pipeline-template | `265219d098ec` (chore: release v0.20.2) | 2026-10-10T10:16:47+00:00 |
| python-ai-driven-development-pipeline-template | `533e0b7dff15` | 2026-10-10T16:25:58+07:00 |

`templates/file-trees.txt` lists the CI/CD-relevant file tree of each template.

**Repository line numbers** are from the working tree of branch `issue-234-a27fac6c586f` on 2026-10-19.
`scripts/version-and-commit.mjs` has uncommitted edits, so its line numbers may move by a few lines.

**Scope.** This report lists only findings that are new, or still open, compared with
`dev/log/issues/168/pulls/169/ANALYSIS.md` and `dev/log/issues/212/pulls/213/ANALYSIS.md`.
Those two analyses already covered these topics, so they are not repeated here:

- the use-m / command-stream `$ is not a function` loader;
- the actionlint and zizmor workflow;
- hash pinning and `persist-credentials`;
- the cargo-audit and npm-audit jobs;
- ESLint for `scripts/`;
- CodeQL `paths-ignore: dev/log`;
- `cargo publish --token` changed to `CARGO_REGISTRY_TOKEN`;
- pinned runner labels.

**Evidence runs** (saved in `ci-logs/` and `runs-main.json` next to this file):

- `39257928573` (push, `7a89d03`);
- `39250359503` (schedule, `8062b5f`);
- `39237723744` (push, `6a9fff0`).

---

## Ranking (by impact)

| # | Finding | Class | Impact |
|---|---|---|---|
| G1 | command-stream `$` resolves on non-zero exit. A failed `npm publish` reports `published=true` and a GitHub release is created anyway | false positive (release) | **critical** |
| G2 | Release jobs ignore coverage, parity, syntax-check, audit and CodeQL. `instant-release` has no `needs` at all | false positive (release) | **high** |
| G3 | Rust coverage step: `cargo tarpaulin … \| tee` without `pipefail`. A test failure is misreported as "Coverage % is below the 50% threshold" | false positive / wrong diagnosis | **high** |
| G4 | `workflow_dispatch` input `bump_type` is `required: true` with no `default:` (best practices §17, HTTP 422) | error | medium (also a template bug) |
| G5 | zizmor `v0.6.2` with `min-confidence: medium` hides `artipacked` (Low confidence) findings. actionlint is 1.7.7, not 1.7.12. `workflows.yml` path filter misses the scripts it runs | false negative | medium |
| G6 | `changeset-pr` creates its PR with `GITHUB_TOKEN`, so no PR checks ever run on it. It also has no `needs` | false negative | medium |
| G7 | Release preflight is a step inside the release job, not a separate first job (§16) | wasted run / late failure | medium |
| G8 | Every `rust.yml` check job has `cancel-in-progress: false`, so superseded PR runs are never cancelled | warning / waste | medium |
| G9 | Unpinned tooling: `bun-version: latest` ×6, `secretlint` via npx, `cargo install cargo-tarpaulin` with a cache key that has no version, `alpine:latest`, `upload-artifact@v6` | flaky / non-reproducible | medium |
| G10 | Experiment scripts (`experiments/issue-195-*.py`, `issue-209-docker.mjs`) run inside the required test and coverage jobs. Their evidence upload uses `if-no-files-found: ignore` | false negative / noise | low-medium |
| G11 | Link checker has no transient re-check, no `lychee.toml` host throttling, an incomplete path filter, and a `--cache` that is never persisted | false negative (red on 429/5xx) | low-medium |
| G12 | No step budgets and no per-test timeout. Release timeout is 30 min (template: 65). No registry wait or smoke test after publish | hang / late signal | low-medium |
| G13 | The Rust stage, cargo-audit and Rust CodeQL are skipped whenever the JS stage fails, including on the weekly schedule | false negative (security) | low (intentional, but costly) |
| G14 | Version push has no classified rebase-retry (§10). This is mitigated by the pre-bump fetch and rebase | error (rare race) | low |

---

## G1. command-stream `$` never throws, so `try/catch` around it is dead code (critical)

**Repository**

`scripts/load-command-stream.mjs` returns `$` as it is and never enables errexit (`grep -c errexit` → 0).
The repository's own helper documents the behaviour, `scripts/release-git.mjs:6-7`:

```js
 * command-stream's `$` resolves on a non-zero exit code. Until #211 a push
 * rejected by the main ruleset (GH013) therefore fell through to
```

Issue #211 fixed only the git calls that go through `checked()`. The npm publish is still unchecked, `scripts/publish-to-npm.mjs:113-133`:

```js
    for (let i = 1; i <= MAX_RETRIES; i++) {
      console.log(`Publish attempt ${i} of ${MAX_RETRIES}...`);
      try {
        await $`npm run changeset:publish`;
        setOutput('published', 'true');
        setOutput('published_version', currentVersion);
        console.log(`✅ Published ${PACKAGE_NAME}@${currentVersion} to npm`);
        return;
      } catch (error) {           // unreachable: $ resolves on non-zero exit
```

The workflow then trusts that output, `.github/workflows/js.yml:560-564`:

```yaml
      - name: Create GitHub Release
        if: steps.publish.outputs.published == 'true'
        ...
        run: node scripts/create-github-release.mjs --release-version "${{ steps.publish.outputs.published_version }}" ...
```

**Proof.** The repository's own loader was run on Node 24 (`/tmp/cs-probe-234/probe.mjs`):

```
await $`sh -c "exit 3"`  ->  RESOLVED code= 3      (no exception)
```

**Other unchecked calls with the same defect**

| File:line | Call |
|---|---|
| `scripts/publish-to-npm.mjs:81` | `git pull origin main` |
| `scripts/changeset-version.mjs:28,31` | `npx changeset version`, `npm install --package-lock-only` |
| `scripts/instant-version-bump.mjs:74,123` | `npm version …`, `npm install --package-lock-only` |
| `scripts/create-manual-changeset.mjs:92` | `npx prettier --write` |
| `scripts/setup-npm.mjs:30` | `npm install -g npm@latest` |
| `scripts/format-github-release.mjs:90` | `node scripts/format-release-notes.mjs` |

If `changeset version` fails, nothing is staged. `version-and-commit.mjs` then logs "No changes to commit" and the job ends green without releasing (a false negative).

**Template.** `js/scripts/use-module.mjs:268-289` turns errexit on centrally:

```js
 * The errexit switch is the semantics every release script is written
 * against: without it `$` RESOLVES on a non-zero exit, so every
 * `try { await $`...`; } catch` in the release path is unreachable and a
 * crashed step prints the success line.
...
  if (shell && typeof shell.errexit === 'function') {
    shell.errexit(true);
```

The template's `js/scripts/publish-to-npm.mjs:185-187` also checks the code explicitly
(`if (publishResult && publishResult.code !== 0) … return new Error(...)`).

**Why it matters.** A failed `npm publish` produces these outcomes:

- the retry loop is skipped;
- the step reports success;
- a GitHub release with an npm badge is created for a version that is not on npm.

`verify-release-badge.mjs` checks only the release body, not the registry, so nothing catches this.

**Recommendation: adopt.** Wrap every listed call in `checked()` from `release-git.mjs`. Alternatively, adopt the template's `shell.errexit(true)` in `load-command-stream.mjs`. If you do that, convert the deliberate probes to explicit code checks first, because they would start throwing:

- `npm view` in `publish-to-npm.mjs:94`;
- `git merge-base --is-ancestor` in `release-git.mjs:60`.

Add a test that runs `publish-to-npm.mjs` against a stub `npm` that exits 1 and asserts `published` is not `true`.

---

## G2. Release jobs do not wait for every required check (high)

**Repository**

`.github/workflows/js.yml:488-489`:

```yaml
    needs: [lint, test]
    if: ${{ !cancelled() && github.ref == 'refs/heads/main' && github.event_name == 'push' && needs.lint.result == 'success' && needs.test.result == 'success' }}
```

`coverage`, `parity`, `syntax-check` and `version-check` are not in `needs`, so the npm release publishes even when they fail. The `pipeline-status` gate (`js.yml:763-789`) runs after the release, so it cannot stop it.

`.github/workflows/js.yml:592`: `instant-release` has **no `needs:` at all**. A manual instant release publishes without waiting for lint or test:

```yaml
    if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.event.inputs.release_mode == 'instant'
```

`.github/workflows/rust.yml:480-485` (and `manual-release` at 623-628):

```yaml
    needs: [lint, test, build]
    if: |
      !cancelled() &&
      github.event_name == 'push' &&
      github.ref == 'refs/heads/main' &&
      needs.build.result == 'success'
```

`coverage`, `test-parity`, `cargo-audit` and `rust-codeql` are listed as required in `rust.yml:825`, but none of them gates the release.

**Live evidence.** In run `39257928573` (push to main):

- `Rust CI/CD / Code Coverage (Rust, Linux only)` = **failure**;
- in the same run, `Rust CI/CD / Build Package` = success and `Rust CI/CD / Auto Release` = **success**.

`Rust Stage` turned red only afterwards. Whether a crate was actually published in that run depends on `check-release-needed`, but the gate did not stop the release job.

**Template.** JS `release.yml:506-537` and `instant-release` `655-679`:

```yaml
    needs: [detect-changes, test-compilation, check-file-line-limits, version-check,
            changeset-check, lint, test, docker-build, validate-docs, release-preflight]
    if: |
      !cancelled() && ... &&
      needs.release-preflight.result == 'success' &&
      needs.lint.result == 'success' &&
      needs.test.result == 'success' &&
      !contains(needs.*.result, 'failure') &&
      !contains(needs.*.result, 'cancelled')
```

**Recommendation: adopt.**

- JS `release` and `instant-release`: set `needs: [syntax-check, lint, test, coverage, parity, version-check, changeset-check]`. Add the `!contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled')` guard. Skipped jobs (for example `changeset-check` on push) stay allowed.
- Rust `auto-release` and `manual-release`: add `coverage, test-parity, cargo-audit, rust-codeql` to `needs` with the same guard.

---

## G3. Rust coverage step loses the tarpaulin exit code (high)

**Repository** `.github/workflows/rust.yml:412-428`. The default shell is `bash -e {0}`, which has no pipefail:

```yaml
          cargo tarpaulin --all-features --timeout 120 --out Xml --output-dir coverage/ 2>&1 | tee coverage/tarpaulin.log
          COVERAGE=$(grep -oP '^\d+\.\d+(?=% coverage)' coverage/tarpaulin.log | tail -1)
          ...
          if python3 -c "import sys; c=float('${COVERAGE}') if '${COVERAGE}' else 0; ..."
            ...
            echo "❌ Coverage ${COVERAGE}% is below the 50% threshold"
```

The same pattern was fixed in `js.yml` for #158, but that fix was never applied to `rust.yml`.

**Live evidence.** Run `39257928573`, `run-39257928573-failed.log` lines 649-665 and 2308-2310:

```
test accepted_launch_with_failed_final_save_attaches_watcher_and_stops_with_identity ... FAILED
thread '...' panicked at tests/regression_193.rs:150:5:
test result: FAILED. 5 passed; 1 failed; ...
Error: "Test failed during run"
Coverage: %
❌ Coverage % is below the 50% threshold
```

Run `39250359503` shows the same pattern with `tests/regression_207.rs:98:9`.

**Why it matters**

- The annotation names the wrong cause (§17 "one outcome, one message"): a test failure is reported as low coverage.
- If tarpaulin ever prints a percentage after a failing test (for example with `--no-fail-fast`), a ≥50 % result turns a failing test run green.

The template has no threshold at all: `rust/.github/workflows/release.yml:653-658` runs `cargo llvm-cov` under `run-with-budget-warning.sh`, without a pipe.

**Recommendation: adopt.**

- Add `set -o pipefail` (or `shell: bash`, which implies `-o pipefail`).
- Fail with "tarpaulin failed (exit N)" before parsing.
- Treat an empty `COVERAGE` as "no coverage report", not as 0 %.

---

## G4. `bump_type` has no default: dispatch via API gets HTTP 422 (medium, template bug)

**Repository** `.github/workflows/js.yml:22-29`:

```yaml
      bump_type:
        description: 'Manual release type'
        required: true
        type: choice
        options:
          - patch
```

**Best practices §17** (`CI-CD-BEST-PRACTICES.md:471,476`):

```yaml
        default: patch # the dispatch API answers HTTP 422 without it
```

**Templates.** The same bug is in all three templates:

- JS `release.yml:22-29`;
- Rust `release.yml:19-26`;
- Python `release.yml:11-18`.

**Recommendation: adopt.** Add `default: patch`. Report it upstream (see the template-bugs section).

---

## G5. Workflow linters are weaker than the template (medium)

**Repository** `.github/workflows/workflows.yml:75-85`:

```yaml
      - uses: zizmorcore/zizmor-action@v0.6.2
        with:
          ...
          inputs: .github/workflows
          min-confidence: medium
```

`scripts/install-actionlint.sh:8` installs `.../download/v1.7.7`.

The path filter (`workflows.yml:12-17`) contains only `'.github/**'`.

**Template.** JS `workflows.yml:112-141` (Rust `77-100` and Python `93-115` are identical in substance):

```yaml
      - uses: zizmorcore/zizmor-action@v0.6.4
        with:
          ...
          # Low, not medium: the artipacked audit reports at Low confidence,
          # and a floor above the finding hides every checkout that forgets
          # persist-credentials: false.
          min-confidence: low
          version: 1.30.1
      - name: Audit for pedantic-only high-severity findings
        run: |
          pipx run zizmor==1.30.1 --config .github/zizmor.yml \
            --persona pedantic --min-severity high --min-confidence high .
```

Other template differences:

- actionlint is `docker://rhysd/actionlint@sha256:b1934ee5… # v1.7.12` (`workflows.yml:56`).
- The path filter adds the scripts the workflow runs (`workflows.yml:9-11`).

**Why it matters.** With a `medium` floor, a newly added checkout without `persist-credentials: false` (the issue #168 class of bug) passes zizmor silently: a false negative. The `unpinned-images` audit (for example of `alpine:latest`, see G9) runs only in pedantic mode.

**Recommendation: adopt.**

- Upgrade to `zizmor-action@v0.6.4` with `version: 1.30.1` and `min-confidence: low`, and add the pedantic high/high pass.
- When moving to zizmor ≥1.30, also copy the template's `self-repository` ignore block from `js/.github/zizmor.yml:17-29`. Otherwise `js.yml`'s `uses: ./.github/workflows/rust.yml` triggers a finding that actionlint cannot accept (rhysd/actionlint#711).
- Upgrade `install-actionlint.sh` to 1.7.12. Keep the native install, because 168/169 chose it to avoid Docker Hub pull quotas and it already asserts `command -v shellcheck`.
- Add `scripts/install-actionlint.sh` and `scripts/check-pipeline-status.sh` to the path filter.

---

## G6. `changeset-pr` opens a PR whose checks never run (medium)

**Repository** `.github/workflows/js.yml:705-707` (the job starts at 672 and has no `needs`):

```yaml
        uses: peter-evans/create-pull-request@5f6978faf089d4d20b00c7766989d076bb2fc7f1 # v8.1.1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

**Template.** JS `release.yml:998-1003` (the job has `needs: [lint]`):

```yaml
          # The built-in token suppresses pull_request workflows; use the same
          # dedicated automation actor as the release fallback (issue #192).
          token: ${{ secrets.RELEASE_PR_TOKEN }}
```

**Why it matters.** GitHub does not trigger `pull_request` workflows for events caused by `GITHUB_TOKEN`. The release PR shows no checks: required checks block it forever, or reviewers merge it untested.

**Recommendation: adopt.** Use a dedicated token or GitHub App token, and fail loudly when the secret is missing (preflight). If no such secret is available, document that a maintainer must push an empty commit to start the checks.

---

## G7. Release preflight is not the first job (medium)

**Repository** `.github/workflows/js.yml:517-523`. It is a step inside `release`, after checkout and setup-node:

```yaml
      - name: Preflight credential checks
        run: |
          node scripts/preflight-credentials.mjs \
            --require gh-token \
            --require npm-oidc
```

`rust.yml:524`, `576`, `668` and `705` (auto-release and manual-release) are also inline.

**Template.** A `release-preflight` job, which every publisher `needs` and gates on `result == 'success'`:

- JS `release.yml:470-503` (`PREFLIGHT_MODE` release/report, `id-token: write`);
- Rust `release.yml:134-159`;
- Python `release.yml:240-268`.

**Best practices §16:** "Put a `preflight` job first and make every publishing job `needs:` it." In report mode on PRs, a missing secret becomes a warning.

**Why it matters.** An expired or revoked credential is discovered only after the whole 3-OS test matrix and coverage have run. On PRs it is never discovered.

**Recommendation: adopt.** Move `preflight-credentials.mjs` into a `release-preflight` job: release mode on push to main and instant dispatch, report mode elsewhere. Add it to the `needs` of `release`, `instant-release`, `auto-release` and `manual-release`.

---

## G8. `rust.yml` never cancels superseded check runs (medium)

**Repository.** `.github/workflows/rust.yml` lines 58, 86, 122, 161, 207, 252, 339, 369, 435, 748 and 770 all read:

```yaml
      cancel-in-progress: false
```

`js.yml`, `security.yml`, `links.yml` and `workflows.yml` all use `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`.

**Template.** Rust `release.yml:72,114,…,682`: `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`. Only writers use `false`.

**Why it matters**

- Every push to a PR runs the full Rust matrix: 3 OS × 30 min, plus coverage, plus CodeQL. Runs for older commits finish after newer ones.
- The groups do not include the workflow name (`check-rust-${{ github.ref }}-…`). That is fine for now, but the template groups are `${{ github.workflow }}-${{ github.ref }}-…`.

**Recommendation: adopt** the `${{ github.ref != 'refs/heads/main' }}` expression for every check job in `rust.yml`. Keep `false` for `auto-release` and `manual-release`.

---

## G9. Unpinned or floating tooling (medium)

| Repository | Line | Template | Recommendation |
|---|---|---|---|
| `js.yml` | 185, 225, 275, 453, 509, 612: `bun-version: latest` | JS `release.yml:351` `bun-version: '1.x'` | Adopt `'1.x'`, or an exact version, so a new Bun major cannot turn main red overnight |
| `js.yml` | 743: `- uses: oven-sh/setup-bun@0c5077e5…` (no `# v2.2.0` comment, no `bun-version`) | — | Add the version comment and `bun-version` |
| `security.yml` | 151: `npx --yes -p secretlint -p @secretlint/secretlint-rule-preset-recommend secretlint …` | JS `release.yml:269`: `npx --yes -p secretlint@13.0.7 -p @secretlint/secretlint-rule-preset-recommend@13.0.7 …` | Adopt the pin. A new rule in a new secretlint release would otherwise fail every run with no commit to blame |
| `rust.yml` | 393-405: tarpaulin cache key `${{ runner.os }}-cargo-tarpaulin-bin` + `cargo install cargo-tarpaulin` | Rust `release.yml:646-651`: `taiki-e/install-action@e67fa11c… # v2.87.4` with `tool: cargo-llvm-cov` | Adopt: install `cargo-tarpaulin@<ver>` through `taiki-e/install-action` (already used for `cargo-audit@0.22.2`). The current key has no version, so it **never** refreshes, and a binary built by an old toolchain stays forever |
| `rust.yml` | 385-391: cache key on `rust/Cargo.lock, rust/Cargo.toml`, no `restore-keys`, no `target/` | Rust `release.yml:524-534`: `restore-keys` + `target` on Unix | Adopt `restore-keys` (a cold cache on every lockfile bump means `CARGO_NET_RETRY` gets exercised more) |
| `js.yml` | 407: `--image alpine:latest` | — | Pin `alpine:3.x@sha256:…`; zizmor pedantic would flag it (G5) |
| `js.yml` | 332: `actions/upload-artifact@v6` | JS `release.yml:865`: `@v7` | Adopt v7 (v6 still runs on Node 20 internals; `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` only masks it) |

---

## G10. Experiment scripts inside required jobs (low-medium)

**Repository**

`js.yml:313-317` (test) and `rust.yml:407-410` (coverage):

```yaml
          python3 experiments/issue-195-ci-image-preparation.py
          python3 experiments/issue-195-ci-docker-capability.py
```

`js.yml:323-336`:

```yaml
      - name: Reproduce stale-sample OOM attribution (Linux)
        run: |
          bun experiments/issue-209-docker.mjs > issue-209-evidence/docker-probe.jsonl 2> ...
      - name: Preserve OOM reproduction evidence (Linux)
        uses: actions/upload-artifact@v6
        with:
          if-no-files-found: ignore
```

**Template.** Experiments are excluded from CI (`js/.github/codeql/codeql-config.yml` ignores `experiments`), and `release.yml` never runs them. Artifacts use `if-no-files-found: error` (JS `release.yml:865`ff).

**Why it matters**

- A probe meant for issue #209 can fail the required `test` job (a false negative for the product).
- `ignore` hides the very case the artifact exists for. §17: "Write logs where the upload step looks."

**Recommendation: adopt.**

- Move the image preparation into `scripts/` (it is production CI logic now).
- Make the #209 probe `continue-on-error: true` in a separate, non-required job, or remove it once #209 is closed.
- Use `if-no-files-found: error` (or `warn` with a `::notice::`).

---

## G11. Link checker (low-medium)

**Repository** `.github/workflows/links.yml`:

- Lines 7-10 and 13-16: the path filter is only `'**.md'`, `'**.html'` and the workflow file. Changes to `.lycheeignore` and `scripts/check-web-archive.mjs` are never validated.
- There is no re-check step for transient failures. It goes straight from lychee to the Web Archive at line 75. A 429 or 5xx from github.com becomes "broken link".
- The repository has no `lychee.toml`.
- Lines 58-59 use `--cache --max-cache-age 1d`, but `.lycheecache` is never persisted between runs. There is no `actions/cache` step, so the flag is a no-op.
- Line 100 says `Report location: lychee/out.md (available as a workflow artifact if configured).`, but no upload is configured.

**Template**

- JS `links.yml:11-16` adds `.lycheeignore`, `scripts/check-web-archive.mjs` and `scripts/recheck-broken-links.mjs` to `paths`.
- JS `links.yml:93-114` adds the re-check step:

  ```yaml
      - name: Re-check transient link failures
        # Retry transport errors, 429, and 5xx within a shared budget.
        if: steps.lychee.outputs.exit_code != 0
        id: recheck
        run: node scripts/recheck-broken-links.mjs
  ```

- `rust/lychee.toml` and `python/lychee.toml`:

  ```toml
  [hosts."github.com"]
  concurrency = 2
  request_interval = "1s"
  ```

**Recommendation**

- **Adopt** `recheck-broken-links.mjs` (plus its fixture test), the `lychee.toml` github.com throttle, and the extended path filter.
- Either add `actions/cache` for `.lycheecache` or drop `--cache`.
- Either upload `lychee/` as an artifact on failure or fix the message.
- A weekly `schedule` would catch link rot on main. No template has one, so this is optional.

---

## G12. Time budgets, release timeout, post-publish verification (low-medium)

**Repository**

- `js.yml:260`: test job `timeout-minutes: 30`. No step budgets, no `bun test --timeout`.
- `js.yml:492,595`, `rust.yml:494,638`: release `timeout-minutes: 30`.
- No `wait-for-npm`, `wait-for-crate` or smoke-test step after publishing.

**Template**

- JS `release.yml:365`: `bash scripts/run-with-budget-warning.sh 200 "Bun test suite" bun test --timeout 30000`.
- JS `release.yml:523`: `timeout-minutes: 65` ("25.5-minute propagation window").
- JS `release.yml:627,633`: publish under a 1800 s budget, then `smoke-test-package.mjs`.
- Rust `release.yml:809-827`: `wait-for-crate.rs` + `smoke-test-published-crate.rs`.
- Python `release.yml:622-633`: same pattern.

**Why it matters**

- A hung test burns 30 min × 3 OS and is reported as "cancelled". `pipeline-status` turns that red, but without naming the step.
- Without a smoke test, a broken tarball (missing `files`, a bad `bin`) is released green.

**Recommendation**

- **Adopt** `run-with-budget-warning.sh` with a `--timeout` per test for `bun test`, and a post-publish smoke test (`npx start-command@<ver> --version`; `cargo install start-command --version <ver>` in a temp dir).
- Raise the release timeout only together with a registry wait.

---

## G13. Rust checks are hidden behind the JS stage (low; intentional)

**Repository** `.github/workflows/js.yml:792-795`:

```yaml
  rust-stage:
    needs: [pipeline-status]
    if: ${{ !cancelled() && needs.pipeline-status.result == 'success' }}
```

The comment at `js.yml:10` reads `# Keep weekly Rust dependency/CodeQL security checks behind the same gate.`

**Why it matters.** When any JS check fails (for example the flaky `Test (Bun on ubuntu-24.04)` in run `39237723744`), the following are all skipped: Rust lint, test, coverage, cargo-audit, Rust CodeQL, and Rust release. On the weekly schedule, a JS flake therefore hides new RustSec advisories for another week.

**Template.** Not applicable: the templates are single-language. §15 says "put the job on the schedule".

**Recommendation.** Keep the stage ordering for release, but move `cargo-audit` and `rust-codeql` into `security.yml`, which runs independently and is already scheduled. Alternatively, run them in `rust-stage` with `if: !cancelled()` on `schedule`.

---

## G14. Version push without classified rebase-retry (low)

**Repository** `scripts/version-and-commit.mjs:498-501`:

```js
      // Push directly to main. A rejected push (such as a ruleset violation,
      // #211) must fail here instead of reporting a release that never
      // reached main; the ancestry check catches anything the exit code hides.
      await checked($`git push origin main`, 'git push origin main');
```

This is mitigated by the fetch and rebase before the bump (`405-444`) and by the shared `main-writer-${{ github.repository }}-main` group. The remaining window is a human merge or another writer between the fetch and the push.

**Template.** JS `scripts/version-and-commit.mjs:284` calls `scripts/push-main-with-rebase-retry.mjs`. It uses `push-failure-classifier.mjs`: GH013/GH006 is routed to `land-via-pull-request.mjs`, and a non-fast-forward triggers a rebase and retry.

**Recommendation.** Optional. Adopt the classifier if releases ever collide. Today a collision fails loudly (correct, but red).

---

## Checked and found equivalent or not applicable

| Item | Status |
|---|---|
| `security.yml` npm-audit `--package-lock-only --audit-level=high`, weekly schedule `0 6 * * 1`, dependency review | Equivalent to JS `security.yml:78-100`. The repository's graph-enabled probe (`security.yml:108-124`) is better than the template's |
| CodeQL `@v4` matrix `[javascript-typescript, actions]` + config file | Equivalent |
| Terminal gate `if: always()` | Matches Python (`release.yml:958`). JS and Rust use `!cancelled()`, which skips the gate when the run itself is cancelled. Keep `always()` (see template bugs) |
| `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` | Not in the templates (they rely on v6/v7 actions). Harmless; remove once G9's `upload-artifact@v7` lands |
| `RUSTFLAGS: -Dwarnings`, `CARGO_NET_RETRY: '10'`, `CARGO_HTTP_MULTIPLEXING: 'false'` (`rust.yml:38-40`) | Equivalent to Rust `release.yml:38,46,47` |
| `dtolnay/rust-toolchain` hash-pinned to master | Equivalent |
| Docker multi-arch publish, `setup-buildx-resilient`, docs deploy, jscpd, file-line limits | Not applicable (no images or Pages; file-size check exists as `check-file-size.mjs`) |
| Root `ci-logs/` (10 tracked `issue-207-*.txt` files) | Not CI config. Note: tracked logs at the repository root are outside `dev/log/` and so outside the CodeQL `paths-ignore`. Consider moving them under `dev/log/issues/207/` |

---

## Bugs in the templates (to report upstream)

1. **`bump_type` has no `default:`** in all three templates. This is the same §17 HTTP 422 defect the best-practices document warns about.
   - JS `release.yml:22-29`, Rust `release.yml:19-26`, Python `release.yml:11-18`.
   - Evidence: `required: true` / `type: choice` / `options:` with no `default:`, while §17 (`CI-CD-BEST-PRACTICES.md:471`) shows `default: patch # the dispatch API answers HTTP 422 without it`.
2. **Rust and Python templates release without waiting for coverage or other checks.**
   - Rust `release.yml:724,732-737`:
     `needs: [lint, test, build, release-preflight]` / `if: … needs.release-preflight.result == 'success' && needs.build.result == 'success'`.
     The following are all absent from `needs`: coverage (604), changelog (163), version-check (195), secrets-scan (228), fresh-merge (246), cargo-lock (344), docker-build (293) and script-tests (550). (`build` itself needs `script-tests`.)
   - Python `release.yml:540,549-553`: same, without `changelog` or `docker-build`.
   - The JS template (`release.yml:506-537`) uses the stricter `!contains(needs.*.result, 'failure')` form. The three templates are inconsistent.
3. **No coverage threshold in any template.**
   - Rust `release.yml:653-658`: `cargo llvm-cov … --lcov` with no `--fail-under-lines`.
   - Python `release.yml:342-345`: `pytest … --cov=src` with no `--cov-fail-under`.
   - JS template: no coverage job at all.
   - Codecov upload is optional (`if: env.CODECOV_TOKEN != ''`), so a coverage regression is never a red signal.
4. **`--cache` without persistence in every `links.yml`.**
   - JS `links.yml:74-75`; Rust and Python are the same.
   - No `actions/cache` for `.lycheecache` exists, yet JS `links.yml:46` claims "Typical run: <1min with lychee cache".
   - JS `links.yml:137` prints "available as a workflow artifact if configured", but no upload step exists.
5. **Terminal gate condition is inconsistent and contradicts §10.**
   - JS `links.yml:154-155`, `security.yml:116-117`, `workflows.yml:157-158`, and Rust `release.yml:1314`: `!cancelled()`.
   - Python `release.yml:958`: `always()`.
   - With `!cancelled()`, a manually cancelled or concurrency-cancelled run skips the gate, so the timeout-to-red conversion the comments promise does not happen in that case.
   - §10 also says "Cancel superseded checks on both pull requests and `main`", but all three `release.yml` files use `cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}`. The template comments (Rust `release.yml:57-63`) justify this, so the document should be updated to match.
6. **Unpinned runner label in the Rust template:** `release.yml:500` `os: [ubuntu-24.04, macos-26, windows-latest]`, and `desktop-release.yml:62` `runner: windows-latest`. Every other label is pinned. 212/213 pinned runners here, but this template line remains.
7. **JS `changeset-pr` swallows formatter errors:** `release.yml:994` `npx prettier --write ".changeset/*.md" || true`.

Prior upstream reports (use-m#72, js-template#151, rust-template#147, python-template#64) cover the loader and zizmor/actionlint topics. None of the items above duplicates them.

Correction during analysis: the JS template's `changeset-version.mjs` and `instant-version-bump.mjs` also call `$` without checking `.code`. They are safe there, because the template's `loadCommandStream` turns errexit on (`use-module.mjs:284-285`). The defect exists only in this repository's copy (G1).
