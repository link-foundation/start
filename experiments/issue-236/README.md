# Docker memory reservation regression

Issue: https://github.com/link-foundation/start/issues/236
PR: https://github.com/link-foundation/start/pull/237

The wrapper rejected `--memory-reservation` before constructing Docker arguments.
The launch and resume resolvers now retain `memoryReservation` alongside the hard
memory and swap limits. Comparison uses effective limits, including an inspected
or saved reservation when a resume lowers the hard cap. A reservation without a
hard cap is allowed; when both are set, the reservation must be strictly lower.
Percentages and percentage ranges use the Docker daemon's RAM and resolve once.
This follows Docker's documented [resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).

| Requirement                                                  | Verification                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Parse sizes and inline flags; pass both limits to Docker     | `js/test/regression-236.js`, `rust/tests/regression_236.rs`; shared CLI and isolation contracts |
| Resolve daemon percentages and preserve resolved bytes       | Regression tests with a fixed daemon capacity and random source                                 |
| Refuse reservation >= hard cap, including inherited values   | Regression tests for launch, overrides and lowering a saved cap                                 |
| Persist and display reservation and original specification   | Record round trips; JSON, text and links status assertions; shared record/status contracts      |
| Preserve on in-place, snapshot and missing-container resumes | Mocked resume integration tests in both editions                                                |
| Preserve during automatic memory recovery                    | Extended issue-191 regressions in both editions                                                 |
| Run against real Docker                                      | `docker-smoke.cjs` in the existing Linux JavaScript and gated Rust test jobs                    |

The JavaScript regressions were run before the implementation: the reported
command failed with `Unknown wrapper option: --memory-reservation`; resolution
ignored the option and accepted reservations above the hard cap. Raw local
before/after logs are retained alongside this file in the working environment.

Run the finite real-Docker probe from the repository root:

```sh
bun experiments/issue-236/docker-smoke.cjs js
# After building the Rust release binary:
node experiments/issue-236/docker-smoke.cjs rust
```

It launches `echo hi` with a 256 MiB hard cap and 64 MiB soft cap, verifies
`HostConfig` and status, then checks plain and snapshot resumes. It cleans up its
containers and snapshot image. It uses a private record store and snapshot lock.
This is a small functional probe with no intentional memory pressure.

Local container startup is unavailable: Docker reports `cannot enter cgroupv2
"/sys/fs/cgroup/docker" with domain controllers -- it is in threaded mode`.
The Linux CI jobs run the probe on a host that supports memory limits. Rust
compilation and the full Rust suite run in the existing gated CI workflow, to
respect this workspace's 2.92 GiB aggregate memory budget.
