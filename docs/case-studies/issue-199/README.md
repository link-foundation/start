# Docker task attribution: issue #199

## Evidence and sequence

The [issue](https://github.com/link-foundation/start/issues/199) was opened at
2026-10-10 07:03:53 UTC against JavaScript 0.36.0. Its complete body and comments
are preserved in `data/issue-199.json` and `data/comments.json`. The linked
[hive-mind incident](https://github.com/link-assistant/hive-mind/issues/2917)
and discussion are also preserved in `data/`. That incident reported four live
task containers while the supervisor counted zero tasks, after store and
process-discovery failures. This is evidence of the attribution problem; labels
alone do not repair an unreliable store or a supervisor's scheduling policy.

Before the fix, `--label hive-mind.tool=codex` failed argument parsing. Without
that flag, task containers had no wrapper attribution. Existing environment
metadata could survive snapshots but could not be selected using Docker's
server-side label filter. The reproducing tests were added before implementation.

## Every requirement and implementation plan

| Requirement                                                              | Considered solutions                                                 | Applied solution and verification                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repeatable Docker-only `--label KEY=VALUE`, like `--env`                 | Add to existing parser; replace parser with a CLI framework          | Extend both existing parsers, accept inline `--label=...`, preserve additional equals signs and empty values, reject empty keys and non-Docker launches; regression-199 tests |
| Apply labels to initial `docker run` and snapshot resumes                | Rely on snapshot image inheritance; explicitly pass labels           | Shared runtime argv builders pass each label explicitly in both languages; shared golden and runtime tests                                                                    |
| Persist labels alongside `env`                                           | Infer labels from daemon state on every resume; store caller intent  | Execution metadata stores caller labels and resume planning carries them forward, including replaced image configuration                                                      |
| Always add session, root-session, execution UUID and resume-count labels | Caller supplies attribution; wrapper owns namespace                  | Wrapper adds all four `start-command.*` labels, protects that namespace against spoofing, and updates attribution on replacement containers                                   |
| Attribute a whole session chain using `docker ps --filter label=...`     | Inspect every container's environment; filter labels                 | Stable root-session and UUID let a supervisor filter live containers without trusting the execution-store status                                                              |
| Optionally use Docker liveness when a stored status is terminal          | Broaden status reconciliation; expose independent daemon attribution | Existing status reconciliation stays available; this optional extension is deferred because labels directly address the required independent discovery mechanism              |
| Apply throughout the codebase and investigate related work               | JavaScript-only patch; parallel native behavior                      | JavaScript and Rust parsing, nested isolation, argv, metadata, and snapshot-resume paths are covered                                                                          |

An in-place resume from issue #198 restarts the same container. Docker labels
are immutable for its lifetime, so its labels describe its creation: its session,
UUID and root-session remain correct, while resume-count remains the count at
creation. A snapshot replacement gets the new session and resume-count. A caller
changing labels on resume needs a replacement container and therefore the
guarded snapshot path. Labels are visible through Docker inspection and should
contain attribution, not credentials.

An initial session name may itself end in `-resume-1`. Both runtimes preserve
that complete root name when the resume count is zero; suffix inference is
limited to resumed sessions without explicit root metadata. Matching regression
assertions failed in both languages before this final-review correction.

```sh
$ -i docker -d --session demo --label hive-mind.tool=codex -- sleep 60
docker ps --filter label=hive-mind.tool=codex
docker ps --filter label=start-command.root-session=demo
```

## Primary research and reusable components

[Docker's object-label documentation](https://docs.docker.com/engine/manage-resources/labels/)
documents the native label and filtering mechanism and the lifetime constraint
on container labels. Its CLI already implements the required storage and
querying, so adding a Docker SDK dependency would duplicate existing CLI use.
[Commander](https://github.com/tj/commander.js) and
[clap](https://docs.rs/clap/latest/clap/) can parse repeatable arguments, but a
parser migration would affect the wrapper's existing separator and stacking
semantics. The small parser extension preserves those conventions.

The downstream issue already exists and contains reproduction and environment
workarounds; this patch introduces no independently reproduced Docker defect
that needs another upstream issue.

## Verification

`js/test/regression-199.js` and `rust/tests/regression_199.rs` verify parsing,
metadata, malformed input and isolation restrictions. Nested Docker forwarding
tests preserve values containing quotes and dollar signs. Shared fixtures verify
the native and JavaScript runtime argv use the same order. The real-Docker
experiment for issue #198 also inspects labels across container reuse.
