# Issue #158 — deep analysis

_"Check for all false positives, false negatives, warnings and errors in CI/CD and fix them all."_

Evidence collected in this folder:

| File                          | Content                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| `ci-logs/js-31380353470.log`  | Full log of the failing JS CI/CD run on `d959632`                            |
| `ci-logs/js-jobs.json`        | Job/step breakdown of that run                                               |
| `ci-logs/rust-31380353804.log`| Full log of the (green) Rust run on the same commit                          |
| `runs-main.json`              | Recent workflow runs on `main`, used to reconstruct the timeline             |
| `CI-CD-BEST-PRACTICES.md`     | Snapshot of the reference document linked from the issue                     |

## 1. Timeline

1. PR #157 (`feat(docker): support multiple networks`, issue #156) merges to `main` as `d959632`.
2. Two workflows trigger on that push:
   - Rust CI/CD run **31380353804** — success.
   - JS CI/CD run **31380353470** — **failure**.
3. The failing job is the Docker network integration test. `ping -c 1 formal-ai`
   succeeds; the command that fails is the second half of the same shell line,
   `wget -q --spider https://api.github.com`, which returns
   `server returned error: HTTP/1.1 403 rate limit exceeded`.
4. Issue #158 is filed asking for every false positive, false negative, warning
   and error in CI/CD to be fixed, using the two pipeline templates and the
   `CI-CD-BEST-PRACTICES.md` document as the reference.

## 2. Requirements, root causes and resolutions

### R1 — Fix the errors in CI/CD

**Root cause.** `js/test/docker-network-integration.js` (and, identically,
`rust/tests/docker_network.rs:80`) asserted network reachability by probing a
*public* endpoint. GitHub's REST API allows 60 unauthenticated requests per hour
**per IP**, and GitHub-hosted runners share egress IPs, so the probe fails
intermittently for reasons unrelated to the product. The multi-network feature
itself was never broken — the alias ping always succeeded.

**Fix.** Both tests now create a *second* local `--internal` network with a
sidecar aliased `formal-db` and assert `ping -c 1 formal-ai && ping -c 1
formal-db`. This still proves the container joined two networks, but is
hermetic: no external dependency, no rate limit. `docker logs` output is folded
into the exit-code assertion message so a future failure carries its own
evidence.

Commits: `c9efac0` (JS), `cc6ffe8` (Rust).

### R2 — Fix the false negatives

**Root cause A — the coverage gate never ran.** `js.yml` parsed Bun's text
coverage report with `grep -oP '\d+\.\d+(?=%)'`. Bun's totals row has no `%`
suffix (`All files | 92.60 | 88.09 |`), so the grep matched nothing,
`parseFloat('')` produced `NaN`, and the step printed *"Could not determine
coverage, skipping check"* and exited 0. The threshold could never fail.

**Root cause B — failing tests were swallowed.** The same step ended with
`| tee coverage.txt || true`, so even a red `bun test` reported success.

**Fix.** `scripts/check-js-coverage.mjs` parses the `All files` row by column
(unit-tested in `js/test/check-js-coverage.mjs`, 7 tests) and treats an
unparsable report as a **hard failure**, not a skip. The test step now runs with
`set -o pipefail` and no `|| true`.

**Root cause C — a timed-out job looked cancelled, not failed.** GitHub reports
a `timeout-minutes` kill as `cancelled`, and there was no aggregate job, so a
run could go red-free with work that never finished.

**Fix.** A `pipeline-status` job (`scripts/check-pipeline-status.sh`) is
appended to all four workflows; it inspects `toJSON(needs)` and fails on any
`failure`, and on `cancelled` when the ref is `main`.

### R3 — Fix the warnings

`actions/checkout` printed the `hint: Using 'master' as the name for the initial
branch` block **15 times** in run 31380353470. Fixed by exporting
`GIT_CONFIG_COUNT=1` / `GIT_CONFIG_KEY_0=init.defaultBranch` /
`GIT_CONFIG_VALUE_0=main` at workflow level in every workflow.

### R4 — Fix the false positives

`.jscpd.json` (inherited from the templates) sets `"format": "console"`. In
jscpd, `format` is the list of **languages** to analyze — output is controlled by
`reporters`. With `format: console` jscpd matches **zero files** and always
reports "No duplicates found": a permanently-green gate. Verified against a
fresh clone of the template itself; with `--format javascript`, `js/src` alone
reports 24 files / 49 clones / 5.64 % duplication.

This repository does not currently run jscpd as a gate, and enabling it would go
red on pre-existing documentation duplication (10.09 % repo-wide), which is out
of scope for this issue. The misconfiguration is therefore **reported upstream**
to both template repositories rather than papered over here.

### R5 — Apply template best practices

Gaps closed against
`link-foundation/{js,rust}-ai-driven-development-pipeline-template`:

- **Workflow-level `concurrency` removed.** A workflow-level group with
  `cancel-in-progress` also cancels a release that has already started pushing.
  Every read-only job now has its own cancellable `check-*` group; every job
  that writes to `main` (`release`, `instant-release`, `changeset-pr`,
  `auto-release`, `manual-release`) shares one non-cancellable
  `main-writer-${{ github.repository }}-main` group — including **across the two
  workflow files**, so a JS release and a Rust release can never race.
- **Least-privilege `permissions: contents: read`** at workflow level; writers
  opt back in individually.
- **`always()` → `!cancelled()`** everywhere except `pipeline-status`, so
  cancellation actually propagates. (Note the YAML trap: `if: !cancelled() && …`
  is invalid YAML because a bare `!` starts a tag — it must be written
  `if: ${{ !cancelled() && … }}`.)
- **`timeout-minutes` on every job.**
- **New `security.yml`**: CodeQL (`javascript-typescript`, `actions`, `rust`),
  `dependency-review-action@v5` (`fail-on-severity: high`), and a secretlint
  secrets scan.
- **New `links.yml`**: lychee link check with a Wayback Machine fallback
  (`scripts/check-web-archive.mjs`) and a `.lycheeignore`. `www.gnu.org` is
  ignored because it answers CI egress IPs with 429 — the same class of
  shared-IP rate limiting that caused R1.

### R6 — Verbose mode when data is insufficient

`js/src/lib/docker-network-lifecycle.js` and
`rust/src/lib/docker_network_lifecycle.rs` now trace the whole
`docker create` → `docker network connect` → `docker start` sequence — command,
exit status, stdout, stderr — behind `START_DEBUG=1`, matching the existing
convention in `isolation.js` / `isolation.rs`. **Default is off**, asserted by a
test in each language.

### R7 — Apply every fix everywhere

The rate-limited probe existed in **both** the JS and Rust test suites; both are
fixed. The CI invariants are asserted from both languages
(`js/test/ci-workflow-invariants.js`, 12 tests;
`rust/tests/ci_workflow_invariants.rs`, 17 tests) so a regression in any of the
four workflow files fails the build regardless of which suite runs.

## 3. Regression tests

| Test                                     | Guards                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `js/test/check-js-coverage.mjs`           | the coverage parser, including "unparsable ⇒ fail, not skip"       |
| `js/test/ci-workflow-invariants.js`       | timeouts, per-job concurrency, writer serialisation, `!cancelled()`, `pipeline-status` completeness, git-init hints, `\|\| true`, script existence |
| `rust/tests/ci_workflow_invariants.rs`    | the same, plus `set -o pipefail`, the parity gate, and the presence of the security and link workflows |
| `js/test/docker-network-lifecycle.js`     | network-list resolution and verbose-off-by-default                 |
| `rust/src/lib/docker_network_lifecycle.rs`| the same, in Rust                                                  |
| `js/test/docker-network-integration.js`, `rust/tests/docker_network.rs` | multi-network attachment, hermetically |

## 4. Existing components surveyed

- **lychee** — link checking; adopted (it is what the templates use, and it
  supports `.lycheeignore` and exclusion paths natively).
- **secretlint** — secret scanning; adopted via `npx`, no install step.
- **CodeQL** — GitHub's own SAST; supports Rust, so a single matrix covers both
  halves of the repository.
- **jscpd** — duplication detection; evaluated, misconfigured upstream, reported
  rather than adopted (see R4).
- **cargo-tarpaulin** — already in use for Rust coverage; no change needed.
- **`bun test --coverage`** has no built-in `--coverage-threshold` failure mode
  in the version pinned here, which is why a small parsing script is the right
  amount of tooling rather than adding nyc/c8.

## 5. Upstream reports

The `.jscpd.json` `"format": "console"` defect is not specific to this
repository — it is inherited verbatim from both pipeline templates, so the fix
belongs upstream. Reports include the reproduction above, the workaround
(`--format "javascript,typescript,markdown"`), and the code fix (move `console`
from `format` to `reporters`).
