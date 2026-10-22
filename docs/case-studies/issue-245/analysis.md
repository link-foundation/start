# All five open issues in one pull request

[Issue #245](https://github.com/link-foundation/start/issues/245) asks for every
open issue in the repository (#240–#244) to be fixed in a single pull request
whose description closes all of them. Each issue has its own case study with
the root cause, the requirement-by-requirement implementation and the evidence.
This page maps the requirements to them. The full issue is in `issue.json`.

| Issue | Problem | Fix | Case study |
| --- | --- | --- | --- |
| [#240](https://github.com/link-foundation/start/issues/240) | `Release` / `Auto Release` skipped on every main push since #234, so nothing was published after 0.38.0 | At job level, `contains(needs.*.result, 'skipped')` also sees skipped ancestors. Both release jobs now compare each needed job's result by name. The stage-status check fails a main push whose release job was skipped although its needs succeeded. Workflow invariant tests in JS and Rust reject `needs.*` in a release condition. | [`issue-240`](../issue-240/analysis.md) |
| [#241](https://github.com/link-foundation/start/issues/241) | With a mounted `docker.sock`, a daemon-restart kill was `Exit evidence: unavailable`, because the check needed the host journal | A Docker API check with no journal needed: other containers that finished in the same 15 s shutdown window with 137/143, or that were restarted by their policy. The attribution source (`journal` / `api`) is stored. `--status` collects the evidence for a watcher lost in the same restart. | [`issue-241`](../issue-241/analysis.md) |
| [#242](https://github.com/link-foundation/start/issues/242) | The cgroup sampler started a `docker exec` and a `docker inspect` every round | One long-lived `docker exec -i` per sampler, paced by host ticks and reading with shell builtins. Liveness probes only after a round without a sample. Falls back to the per-round exec. `START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS=off` turns sampling off. | [`issue-242`](../issue-242/analysis.md) |
| [#243](https://github.com/link-foundation/start/issues/243) | `--status` about 1 CPU-second and `--list` about 16 CPU-seconds with 39 records | The store is decoded once per process (content-keyed cache), plus a digest-checked JSON copy for the next process. One batched `docker inspect` per `--list` / `--status`. Records whose container is known to be removed are never probed. | [`issue-243`](../issue-243/analysis.md) |
| [#244](https://github.com/link-foundation/start/issues/244) | Hundreds of zombies per long-running docker task, because the command is PID 1 | Opt-in `--init` / `--no-init` and `START_COMMAND_DOCKER_INIT` (Docker's bundled tini). It is stored in the record, reused on resume, and shown in `[Isolation]`, the start block and `--status`. Exit evidence is unchanged, which the real-daemon tests and a CI experiment check. | [`issue-244`](../issue-244/analysis.md) |

Every change is in the JavaScript edition first and in the Rust edition in
parity (`parity/features.json`). The pull request has one JS changeset
(`js/.changeset/issue-245-open-issues.md`) and one Rust changelog fragment per
issue (`rust/changelog.d/`).

## CI failures on the pushed #243 commit

JavaScript CI/CD run 39692685074 on `b4a1a82` failed in three jobs. The
failed-job log is preserved in `ci-logs/issue-245/js-ci-39692685074-failed.log.gz`.
Rust CI/CD did not start, because it waits for the JavaScript stage.

| Job | Error | Root cause | Fix |
| --- | --- | --- | --- |
| Behavioral Parity | `cli: change the JavaScript and Rust implementations or behavioral tests together` | Against the run's base `3d11f6bf`, the only `cli` file that changed was `rust/src/lib/mod.rs` (the new #243 modules). #244 changes `usage.js` and `usage.rs`, which balances `cli`, but then the same check reported `docker-cleanup` and `parity-threshold`, because `build_docker_runtime_args` lives in `docker_cleanup.rs` and the Rust golden harness gained an `init` field while their JS counterparts were untouched. | Shared `cli-parsing` goldens for `--init`, `--no-init`, the default and `--init` without docker (`parity/fixtures/contracts.json`). The JS golden harness now parses them without a host `START_COMMAND_DOCKER_INIT`, and the Rust one compares `init`. A JS test checks that `--init` is forwarded only to a remaining docker level of a stack. The check passes with `PARITY_BASE_SHA` set to `origin/main`, `3d11f6bf` and `b4a1a82`. |
| Test (Bun on ubuntu-24.04), "Verify Docker cgroup sampler polling" | `Real Docker polling or memory sample regression` (`experiments/issue-238-real-docker.mjs:107`) | The probe from #238 still expected one `docker exec` per round in the hidden-cgroup mode. #242 replaced those with one long-lived `docker exec -i`. The uploaded trace shows exactly that, with `exec: 1`, `liveness: 1` and a correct `sample=33554432` sample. | The probe now requires exactly one `exec -i` in hidden mode and none with a readable local cgroup. A return to per-round execs fails it. |
| Test (Bun on windows-2025) | `renders the per-record templates from the batch only inside a query`: `null` instead of the batched answer | The test's fake `docker` is a `#!/bin/sh` script, which Windows cannot spawn, so the batch was empty. The other fake-docker tests in the file were already skipped on Windows, and the Rust counterpart is in a `#[cfg(unix)]` module. | The test is skipped on Windows like its neighbours. The pure parsing tests still run there. |
| Rust Test (windows-2025), run 39698521787 on `88bf2c3` | `unused imports` / `function ... is never used` in `tests/regression_243.rs` and `tests/regression_241.rs` under `-Dwarnings` (`ci-logs/issue-245/rust-windows-test-39698521787-failed.log.gz`) | Helpers and imports used only by `#[cfg(unix)]` tests are dead code on Windows. Linux builds never see it, and the earlier Rust CI did not run because the JavaScript stage failed. | The helpers and imports are `#[cfg(unix)]` as well. `RUSTFLAGS="-D warnings" cargo check --tests --target x86_64-pc-windows-gnu` passes locally. |
| Rust Test (ubuntu-24.04), "Verify Docker memory reservation launch and resumes", run 39702101563 on `67a47a8` | `ENOTEMPTY, Directory not empty: /tmp/reservation-236-…` from `fs.rmSync` in the `finally` of `experiments/issue-236/docker-smoke.cjs`, after every assertion had passed (`ci-logs/issue-245/rust-ubuntu-test-39702101563-failed.log.gz`) | A timing race in the test's cleanup, not a product regression: the same step passed on `6e01001`, and `67a47a8` only removes a `.gitkeep`. Each detached launch leaves a completion watcher (`sh -c`, inheriting `START_APP_FOLDER`) that finalizes the record after the container exits. Its writes are atomic, so `executions.lino.<pid>.<uuid>.tmp` appears in the folder and is renamed over the store. One that lands between the scan and the final `rmdir` of `rmSync` makes it fail. Under Bun the same race does not throw; it leaves the folder behind. `experiments/issue-245/state-folder-cleanup-race.cjs` reproduces both without Docker (Node: `ENOTEMPTY` in 8–14 of 20 trials). | `experiments/issue-236/state-folder.cjs` waits, for up to 60 s, until no process has the folder as `START_APP_FOLDER` (read from `/proc/<pid>/environ`), then removes it, retrying `ENOTEMPTY`/`EBUSY`/`EPERM`. The reproduction removes the folder in 20 of 20 trials under Node and Bun. `experiments/issue-245/state-folder-real-watcher.cjs` checks it against the real watcher of both editions: it waits about 5.6 s for the finalizer, and nothing recreates the folder afterwards. |

## Verified only in CI

The development host cannot start containers with `--memory`, because the
memory controller is not delegated. Two real-daemon checks therefore ran only
on the Linux CI runner (JavaScript CI/CD run 39698521787):

- **#244, the OOM case.** `experiments/issue-244-tini-exit-evidence.js` runs
  with `ISSUE_244_REQUIRE_OOM=1`, so a skipped OOM case fails the job. It
  attributed both OOM kills the same way, with and without `--init`: `exit=137
  oom=true reason=memory-exhaustion (cgroup-oom-killer)`
  (`ci-logs/issue-244/tini-exit-evidence-ci-39698521787.txt`).
- **#242 on a real daemon.** One `docker exec` and one liveness probe for twelve
  one-second rounds (`ci-logs/issue-242/real-docker-probe-ci-39698521787.jsonl`).

## What can only be proven after merge

- **#240:** the release jobs run only on a push to `main`, so the first main push
  after the merge is the final proof that `Release` / `Auto Release` run. Probe
  runs on pull requests reproduced the root cause and confirmed the fixed
  condition. The `instant-release` dispatch from the issue still works until
  then.
