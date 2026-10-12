# Issue 209 work plan

- [x] Read issue, every comment, PR conversation/reviews, branch and repository guidance.
- [x] Archive related issue/PR evidence and research authoritative Docker/cgroup sources.
- [x] Trace evidence collection, attached/detached finalization, recovery and status history.
- [x] Add failing minimal regression tests before implementation.
- [x] Implement JavaScript Docker event attribution with ordinary-exit and daemon-restart safeguards.
- [x] Enrich historical attempts independently, preserving each attempt's evidence and log scope.
- [x] Maintain corresponding Rust adapters/tests, feature inventory and shared contracts.
- [x] Run finite, memory-bounded reproduction experiments and preserve raw results (local daemon cannot start limited containers; real probe added to Linux CI).
- [x] Document timeline, all requirements, root causes, alternatives and evidence limits.
- [x] Add release fragments; generate supported policy code and verify regeneration.
- [x] Run local JavaScript checks/tests; review logs and focused parity checks.
- [x] Commit coherent changes, verify current main ancestry and clean worktree.
- [x] Wait for all earlier branch CI runs; archive all failed/cancelled logs if any.
- [ ] Push only the prepared branch; inspect all completed checks and correct all failures together.
  - First completed run: JavaScript suites passed; real fatal OOM and normal-exit
    probes passed; external-kill control failed because namespace PID 1 ignored
    its own SIGKILL. Preserve logs/artifact and deliver the kill through Docker.
- [ ] Review final PR diff/title/body against every requirement; mark PR 210 ready after passing CI.

Work is performed by one agent, which owns all pushes. Builds and memory-heavy
tests run sequentially within the 2.92 GiB container limit. Rust validation is
delegated to the JavaScript-gated CI unless local evidence requires a focused
bounded investigation. Raw CI logs are retained in `ci-logs/`.
