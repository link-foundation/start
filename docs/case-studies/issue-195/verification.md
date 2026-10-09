# Verification and reproduction limits

## Automated checks

- JavaScript full suite: 1,112 passing tests across 67 files; 89.92% line coverage exceeds the existing 45% gate.
- Rust: 986 tests pass across all targets/all features, plus six documentation tests.
- JavaScript `bun run check`: ESLint, shared scripts lint, Prettier and 1,000-line source limit pass.
- Rust `cargo fmt --check` and `cargo clippy --all-targets --all-features -- -D warnings`.
- `node scripts/check-test-parity.mjs` and `node scripts/check-doc-examples.mjs --implementation all` pass.
- New regression files `js/test/regression-189.js` through `regression-194.js`, and corresponding Rust files.

Fault injection covers empty/truncated locks and invalid owner types, partial ENOSPC writes, reservation ordering, save failures after accepted launch, watcher attachment, stop failure identity, concurrent writers and dead launcher recovery. Safe shell fixtures cover hidden local cgroups, daemon exec fallback, missing shells, shared namespaces and transient outages. Virtual-time CPU tests cover full cycles, weighted windows, gaps, resize, restart, ineffective caps and base restoration. A finite monitor fixture verifies apply/lift/reapply with tracking disabled; resume tests preserve legacy CPU quota format during explicit overrides.

## Real Docker evidence

[Smoke results](data/docker-smoke-results.json) verify ordinary attached and detached launches in both CLIs, final status/exit and the explicit memory-unavailable/HostConfig line. This runner's caller mount does not expose task cgroups and its Docker namespace prevents a valid private fallback, so it exercises the unavailable path.

The finite [resource-control probe](../../../experiments/issue-195-real-docker.py) constrains each task to 64 MiB and one CPU for an 18-second busy/quiet workload. It checks apply/lift logs, configured swap, status, a 128 MiB snapshot resume and original base quota. The real launch is blocked before the workload starts by runc:

> cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers -- it is in threaded mode

The full command/result is preserved in [docker-limit-probe.txt](data/docker-limit-probe.txt). This environment therefore cannot validate actual memory/CPU enforcement or an actual main-process cgroup OOM. The policy, argument construction, ordering and diagnostics are verified with injected runners and fixtures. The probe is committed for execution on a host with usable domain controllers.

No host-wide OOM, full-disk stress or live daemon restart was attempted. Those would affect unrelated work. Their supplied incident evidence is preserved, and their software failure paths are reproduced by bounded fault/journal fixtures. There is no destructive unbounded `tail /dev/zero` example in the new tests.

## Reusable commands

```bash
cd js && bun run check && bun run test
cd ../rust && cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets --all-features
cargo test --doc --all-features
cd .. && node scripts/check-test-parity.mjs
node scripts/check-doc-examples.mjs --implementation all
python3 experiments/issue-195-docker-smoke.py
python3 experiments/issue-195-verify-evidence.py
# Requires a Docker daemon with working memory/CPU controllers:
python3 experiments/issue-195-real-docker.py
```

The deterministic archive script `experiments/issue-195-preserve-evidence.py` creates gzip files with stable headers and SHA-256 manifests. Raw downloads are ignored by Git; compressed redacted copies are committed. To read a large log in bounded chunks, for example:

```bash
gzip -dc docs/case-studies/issue-195/data/gist-21335417cc285d8ed249fc6465bd36d3.log.gz | sed -n '1,1500p'
```

The recent-counter policy is a temporal proxy permitted by #194, not exact main-PID attribution. One-second sampling may miss a terminal change. Daemon restart classification requires local journal access and a matching container force-kill line; remote or inaccessible journals leave the cause unknown. These constraints are explained in the user guide and dedicated case study.
