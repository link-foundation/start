# Docker cgroup polling

[Issue #238](https://github.com/link-foundation/start/issues/238) reports
36–47 sampler rounds per minute per task and 0.13–0.17 CPU cores per task in
one host measurement. These are the reporter's observations, not measurements
from this development container. The complete issue is saved in `issue.json`.
There are no required sub-issues or issue/PR review comments at investigation
time. #209 describes the existing independent Docker OOM event evidence;
hive-mind #3614 supplies the upstream polling context.

## Cause and implementation

Both language implementations generated a shell loop with a fixed `sleep 1`,
an unconditional `State.Running` inspection, and a `CgroupnsMode` inspection
on every failed local counter read. Attached diagnostics and detached completion
watchers share this sampler, so changing the common builder covers both paths.

The sampler now validates `START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS` in
the watcher environment. It accepts positive whole seconds representable by
the shell integer comparison. Unset, empty, zero, negative, fractional,
malformed and overflowing values use five seconds. The first sample remains
immediate. Subsequent rounds run after the previous round and its sleep finish,
so there are at most twelve recurring rounds per minute with the default.

Namespace resolution happens once before the loop. Readable ID-attributed
local `memory.events` files avoid Docker liveness inspections; hidden, remote
or removed local cgroups retain the Docker fallback. A stopped remote container
ends the sampler, and the completion watcher still stops it after `docker wait`.
Unavailable diagnostics, last valid samples and the final local read are kept.
The Rust adapter also uses the JavaScript PID-specific sample filename.

Sampling remains periodic; the issue explicitly calls adaptive sampling optional.
Keeping a fixed operator-selected interval makes the sampling cost predictable.
The existing three-second OOM evidence window is unchanged: a larger observation
gap must not turn an old child kill into attributed main-process OOM evidence.
The #209 Docker event query remains available for independent exit-137 evidence.
Longer intervals can miss the final counter increment if the cgroup disappears
before the final read. The README documents that trade-off and the one-second
override for operators who prefer more frequent samples.

## Requirement evidence

| Requirement                                  | Implementation                                                                         | Verification                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Configurable interval, default five seconds  | Common JS/Rust sampler builders; watcher environment validation                        | Shared finite fixture checks default, override and eight invalid inputs                                  |
| Resolve immutable namespace once             | One `HostConfig.CgroupnsMode` inspect before the loop                                  | Exact invocation counts across local, remote, shared-namespace, no-shell and outage scenarios            |
| Avoid per-round local Docker liveness probes | Shell readability check before `State.Running` fallback                                | Three local readable rounds make zero liveness probes; one after removal; remote rounds retain probes    |
| Preserve memory/OOM evidence                 | Final read and conservative three-second timing                                        | Clock-controlled final-read tests at five- and one-second gaps; existing #182/#192/#194/#209 regressions |
| JavaScript first, matching Rust evidence     | JS regression implemented first, Rust shell adapter and native tests, parity inventory | Same `experiments/issue-238-cgroup-polling.sh` fixture executes both emitted shells                      |
| Release/documentation                        | JS changeset, Rust changelog fragment, README configuration                            | Normal release and CI gates                                                                              |

`ci-logs/issue-238/reproduction-before.log` records four failing reproducing
tests on the original implementation. `reproduction-after.log` records all five
passing after the change. The fixture advances a simulated clock rather than
waiting or stressing memory, and kills a regressed sampler after a finite
number of rounds. Container names with quotes and cgroup paths with spaces
exercise shell quoting. Both suites check sample-file cleanup.

`experiments/issue-238-real-docker.mjs` runs three sequential twelve-second
containers, each capped at 32 MiB memory/swap, 32 PIDs and 0.2 CPU. It records
every Docker invocation and checks namespace/liveness counts and real memory
samples with default and one-second intervals, including forced hidden-cgroup
fallbacks and the actual sleep arguments. JavaScript CI executes this
probe on Linux and uploads its raw output as `issue-238-docker-evidence`.
The local daemon rejected resource-limited containers because its cgroup parent
is threaded (`cannot enter cgroupv2 ... with domain controllers`). This local
environment failure is preserved in `real-docker.log`; CI supplies the live
resource-limited verification on a suitable runner. No host cgroup changes or
resource-limit removals are used to bypass it.

## Baseline CI failure

The initial branch commit was `c14c5796a9e96a56a053d460e09a81cc25ec6f66`.
Both initial runs were created at 2026-10-21 05:40:13 UTC, after that commit.
Security run 39550857630 failed its NPM Audit: lines 178–190 of the preserved
`baseline-npm-audit-39550857630.log` report `launch-editor <=2.14.1`, severity
high, three advisory references and exit code 1. The lockfile's transitive
development dependency was updated to 2.14.2 in both npm and Bun lockfiles.
`npm audit --package-lock-only --audit-level=high` then reports zero
vulnerabilities. The complete Security log is preserved without modification.
No audit suppression or timeout changes are used.

Raw log names above are preserved as gzip archives under `ci-logs/issue-238/`.
The full local JavaScript suite passed (1453 passed, one unavailable-tmux skip,
zero failures). Local lint/format, shared contracts, workflow guards, manifest
inventory, pinned translator regeneration and documented examples also passed.
