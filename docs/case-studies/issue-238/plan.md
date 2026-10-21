# Issue #238 work plan

Objective: implement and verify every requirement of issue #238 in PR #239 on
`issue-238-a42cab4e013d`, keeping the PR unmerged.

- [x] Read the complete issue, comments, PR conversation, inline comments and reviews.
- [x] Inspect related #209 OOM evidence and hive-mind #3614 polling context.
- [x] Confirm prepared branch and initially clean worktree.
- [x] Reproduce recurring probes with a finite mocked-Docker shell regression.
- [x] Set a five-second default and validate a positive configurable sample interval.
- [x] Resolve the fixed container namespace once; avoid recurring liveness probes
      while the local cgroup counters are readable; preserve remote fallback.
- [x] Verify final reads, sampler shutdown, unavailable diagnostics and conservative
      OOM timing with both default and custom intervals.
- [x] Maintain matching Rust shell behavior and regression evidence; update parity inventory.
- [x] Document configuration and the sampling/OOM trade-off; add a release changeset.
- [x] Run all local JavaScript checks/tests, parity and pinned translation checks.
- [ ] Inspect every failure from completed baseline CI runs, preserve raw logs,
      correct all failures together and verify their causes.
- [ ] Review complete diff, current main ancestry and clean commits; wait for old
      runs to finish before pushing only the prepared branch.
- [ ] Update PR title/body with reproduction, tests, requirements and `Fixes #238`.
- [ ] Wait for every final CI job, preserve any failures, fix and repeat as needed.
- [ ] Confirm final diff, clean worktree, main ancestry, JavaScript/Rust gates and
      every check; mark PR #239 ready only when all requirements are verified.

Issue #209 and hive-mind #3614 are context references, not required sub-issues.
Adaptive sampling is explicitly optional; keep the configured cadence stable.

Local evidence: `ci-logs/issue-238/*.log.gz` preserves the reproducing
failure, passing checks, full test suite and the local Docker environment limit.
Native Rust and live bounded-Docker verification run through the same-commit CI
gates; no local Rust compilation competes with the container memory budget.
