# Requirements and disposition

## Issue requirements

| ID  | Requirement                                                                                  | Disposition                                                                                                               |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R1  | Remove the rate-limited `https://api.github.com` probe from the JavaScript integration test. | Complete. The executable probe has no URL.                                                                                |
| R2  | Apply the same correction to `rust/tests/docker_network.rs`.                                 | Complete. JavaScript and Rust share equivalent commands and assertions.                                                   |
| R3  | Pass even when the runner's unauthenticated GitHub quota is exhausted.                       | Complete by construction: neither test contacts GitHub or another internet host.                                          |
| R4  | Continue proving that private network aliases are reachable.                                 | Complete: `formal-ai` and `formal-db` run on separate internal networks.                                                  |
| R5  | Continue proving that the primary/default bridge route survives extra attachments.           | Complete: the tested container starts on `bridge` and asserts a default route after both internal networks are connected. |
| R6  | Make failures diagnostic rather than reporting only `'1' !== '0'`.                           | Complete in PR #159: both suites include `docker logs` in the exit-code assertion.                                        |
| R7  | Restore availability of JavaScript 0.32.0.                                                   | Complete upstream of this PR: main run 31388354106 published it at 2026-08-10T12:32:46Z.                                  |

## Issue-comment requirements

| ID  | Requirement                                                                    | Disposition                                                                                                                                |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| R8  | Download all issue-related logs and data into `docs/case-studies/issue-160`.   | Complete: four full workflow logs plus issue, PR, reviews, workflow/job, release, registry, source, diff, and test artifacts are retained. |
| R9  | Reconstruct the complete timeline.                                             | Complete in `timeline.md`.                                                                                                                 |
| R10 | Inventory every requirement and root cause.                                    | Complete here and in `root-cause.md`.                                                                                                      |
| R11 | Propose solutions and plans for every requirement.                             | Complete in `solutions.md`, including rejected alternatives.                                                                               |
| R12 | Search online for additional facts and relevant existing components/libraries. | Complete in `online-research.md`, using official sources.                                                                                  |
| R13 | If evidence is insufficient, add off-by-default diagnostics.                   | Evidence is sufficient; PR #159 had already added `START_DEBUG=1` lifecycle tracing with default off.                                      |
| R14 | Apply the correction everywhere in the codebase.                               | Complete: repository search found the executable probe only in the historical experiment and evidence. Both active suites are protected.   |
| R15 | Report actionable third-party defects when appropriate.                        | Not applicable: no third-party behavior is defective. No upstream issue was created.                                                       |

## Verification requirements

| ID  | Requirement                        | Evidence                                                                                                                |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| V1  | Preserve a minimal reproduction.   | `experiments/docker-network-flake-repro.mjs` and the historical source snapshots in `data/`.                            |
| V2  | Add an automated regression test.  | `keeps the multi-network probe hermetic` in JavaScript and `multi_network_probe_is_hermetic` in Rust.                   |
| V3  | Exercise the real Docker daemon.   | Focused logs in `data/js-focused-test.log` and `data/rust-focused-test.log`.                                            |
| V4  | Keep tests bounded.                | The JavaScript integration cases retain their explicit 120-second per-test budgets.                                     |
| V5  | Avoid an unnecessary release bump. | The changes affect integration tests and documentation only; published runtime behavior and package APIs do not change. |
