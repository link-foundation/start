# Reproduction and validation

The original source failed all seven initial regressions: observed-base restart,
NanoCPU and legacy post-launch limits, zombie and reused-PID locks, and monitor
death under supervision. Raw [baseline output](../../../../ci-logs/issue-207-baseline.txt)
is preserved. Additional failing regressions isolated
[daemon-clamped restart](../../../../ci-logs/issue-207-clamped-baseline.txt) and
[inode reuse on lock release](../../../../ci-logs/issue-207-inode-reuse.txt).

Local checks on 2026-10-11:

- `cd js && bun run check && bun run test`: 1,220 tests pass, zero fail.
- Shared golden contracts and CI workflow guards: 35 tests pass.
- Manifest/source inventory: 20 features verified.
- `node scripts/setup-translation.mjs` and
  `bun scripts/generate-rust.mjs --check`: pinned translator regenerates and
  verifies the executable Rust mapping.
- `cargo fmt --all --manifest-path rust/Cargo.toml --check`: passes.
- Native compilation/tests run in the existing same-commit CI stage after the
  entire JavaScript stage succeeds. No local compile tree was started in this
  2.92-GiB container.

The adapter regressions use the same finite
[Docker fixture](../../../../experiments/issue-207-monitor.py) from both runtimes.
They assert actual CPU update results, persisted base, JSON status, restarted
monitor recovery, zombie/legacy-reused owners, publication retry, graceful
restoration and a supervisor override during the penalty. JavaScript additionally
injects one exception each in inspection, stats, update and publication. All
checks require progress and fresh window coverage; test counts alone are not
equivalence evidence.

For the real acceptance probe, run:

```sh
docker pull alpine:3.23
python3 examples/issue-207-cpu-recovery.py
```

The [raw successful probe](../../../../ci-logs/issue-207-real-docker.txt) shows
post-launch `docker update --cpus 4` on a 6-CPU daemon, a default 95% trigger to
2 CPUs, SIGKILL of the watcher/supervisor/monitor, real CLI `--resume-all`, and
restoration to 4 CPUs after the workload becomes idle. Both HostConfig and
`--status --output-format json` verify the result. Eight tiny shell loops stop
after 22 seconds; the container independently exits after 55 seconds. The script
removes its container and stops the old watcher's orphaned subprocesses.

An earlier four-loop probe did not cover a full 95% busy window on this host;
its [raw failure](../../../../ci-logs/issue-207-insufficient-load.txt) is retained.
The final probe saturates the external quota with more runnable loops; it does
not lower the threshold or lengthen the failed reproduction's wait. START_DEBUG
now traces measured cores, daemon capacity, phase, base and cap, as well as tick
failures. Tracing remains off by default.

Full [JavaScript check](../../../../ci-logs/issue-207-js-check.txt),
[test](../../../../ci-logs/issue-207-js-tests.txt),
[shared-contract](../../../../ci-logs/issue-207-parity.txt), and
[generation](../../../../ci-logs/issue-207-generation.txt) logs are preserved.
SIGKILL cannot run cleanup; recovery requires a surviving supervisor or explicit
reattachment. An indefinite Docker outage prevents any process from restoring
a quota. These are the material limits, not deferred child-issue requirements.
