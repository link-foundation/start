# Timeline

All timestamps are UTC.

1. **2026-08-10 09:45:06** — Issue #156 requests repeatable Docker
   `--network` support, including the bridge-plus-private-sidecar use case.
2. **10:36:50** — Commit `78d0290` implements multi-network support and adds
   JavaScript and Rust integration probes. Each uses
   `ping formal-ai && wget --spider https://api.github.com`.
3. **10:43:14** — PR #157 merges as `d959632`; issue #156 closes one second
   later.
4. **10:43:16** — JavaScript CI/CD run 31380353470 begins on `d959632`.
5. **10:43:17** — Rust CI/CD run 31380353804 begins on the same revision.
6. **10:44:03** — The JavaScript Ubuntu job's probe container returns exit 1.
   The test reports only `'1' !== '0'`; its sibling jobs pass.
7. **10:44:26** — The JavaScript test job exits 1 after 714 passes and one
   failure. Downstream build/release jobs are skipped.
8. **10:46:30** — The Rust workflow publishes 0.19.0. Its identical probe
   happened to pass during that run, demonstrating the flake's dependence on
   timing/source address rather than language behavior.
9. **11:22:32** — Issue #158 opens a broad CI correctness investigation.
10. **11:38:57** — Issue #160 records the specific rate-limit failure,
    reproduction, affected files, diagnostics gap, and blocked JS release.
11. **11:46:06** — PR #159 commit `c9efac0` makes the JavaScript probe local and
    adds container-log diagnostics.
12. **12:04:15** — Commit `cc6ffe8` applies the hermetic probe to Rust.
13. **12:07:02** — Commit `f2c2096` adds opt-in `START_DEBUG=1` lifecycle
    tracing, default off.
14. **12:30:31** — PR #159 merges as `e8ec5e5`.
15. **12:30:35** — Fixed JavaScript run 31388354106 starts. The local-alias
    probe passes in both coverage and Ubuntu test jobs.
16. **12:32:46** — That run publishes `start-command@0.32.0` to npm; the GitHub
    release follows one second later.
17. **12:34:30** — Rust's self-healing release flow creates 0.19.1 from the PR
    #159 changes; the workflow completes successfully.
18. **15:01:19** — Issue #160's comment requests this durable evidence bundle
    and deep case study.
19. **15:23:18** — The prepared PR #161 branch is created from `db1ad4d`, so it
    already contains PR #159's runtime fix and both published release commits.
20. **PR #161** — The tests are strengthened to start on `bridge`, attach two
    internal networks, check both aliases and the retained default route, and
    enforce a no-HTTP invariant in both languages.
21. **15:42:26** — The first PR JavaScript and Rust workflows start on
    `3562e61`. Their release-policy gates fail because changes under both test
    suites require package release metadata; downstream test matrices are
    skipped.
22. **PR #161 follow-up** — A validated JavaScript patch changeset and Rust
    patch changelog fragment are added. The complete failed-run logs and local
    validation output are retained with the case study.

The raw timestamps and SHAs are retained in `data/recent-main-runs.json`, the
four `*-run-*.json` files, issue metadata, PR metadata, and release metadata.
