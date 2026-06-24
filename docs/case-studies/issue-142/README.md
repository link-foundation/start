# Issue 142 Case Study: Docker `--stop` Does Not Stop Detached Containers

## Summary

Issue #142 reports that `$ --stop <session>` reports success for a detached
Docker isolation run, but a follow-up `$ --status <session>` still shows the
container executing. The issue data shows that the command sent `SIGINT` with
`docker kill --signal=SIGINT`, while the manual workaround was
`docker stop <containerId>`.

## Evidence Collected

- Issue data: [issue-data.json](issue-data.json)
- Issue comments: [issue-comments.json](issue-comments.json)
- PR draft state: [pr-143.json](pr-143.json)
- Related merged PRs: [data/recent-docker-isolation-prs.json](data/recent-docker-isolation-prs.json)
- Code search for the old Docker SIGINT behavior:
  [data/code-search-docker-sigint.txt](data/code-search-docker-sigint.txt)
- Regression test failure before the fix:
  [data/repro-js-before.log](data/repro-js-before.log),
  [data/repro-rust-before.log](data/repro-rust-before.log)
- Focused regression test success after the fix:
  [data/repro-js-after.log](data/repro-js-after.log),
  [data/repro-rust-after.log](data/repro-rust-after.log)
- Post-push CI metadata gate failures and logs:
  [ci-logs/javascript-cicd-28117408439.log](ci-logs/javascript-cicd-28117408439.log),
  [ci-logs/rust-cicd-28117408560.log](ci-logs/rust-cicd-28117408560.log)

## Implemented Plan

1. Add JavaScript and Rust regression tests proving Docker stop control must call
   `docker stop <container>`.
2. Change Docker `--stop` control from `docker kill --signal=SIGINT` to
   `docker stop`.
3. Keep Docker `--terminate` mapped to `docker kill`.
4. Update help text and stale case-study references so the public contract says
   `--stop` asks detached executions to stop gracefully.
5. Preserve the existing detached Docker completion watcher behavior so logs,
   exit-code enrichment, and cleanup policy still run after the container stops.

## Outcome

Detached Docker `--stop` now follows Docker's container stop lifecycle instead
of sending a raw custom signal. This matches the issue workaround, honors image
or container stop-signal configuration, and lets Docker escalate to `SIGKILL`
after its timeout if the container does not exit.
