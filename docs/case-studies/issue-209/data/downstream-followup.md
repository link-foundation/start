Follow-up to the upstream attribution safeguard: [start issue #209](https://github.com/link-foundation/start/issues/209) found the opposite failure when a real main-process OOM kill occurred after the final sampled cgroup delta. [start PR #210](https://github.com/link-foundation/start/pull/210) adds a bounded Docker OOM-event query through the configured socket, preserving this issue's daemon-restart veto and ordinary-exit safeguards.

Reproduction in the PR checkout:

```sh
node experiments/issue-209-docker.mjs
bun test ./js/test/regression-209.js ./js/test/regression-194.js ./js/test/regression-191.js
```

The real Docker experiment creates sequential containers capped at 128 MiB, 32 PIDs and half a CPU, with finite allocations and a 70-second worker alarm. A child is OOM-killed first; the main process is OOM-killed about 30 seconds later, while the retained sample still reports only the child kill. Controls use ordinary exit 1 and an external Docker SIGKILL after the child kill. Only the main-OOM scenario gains `memoryExhausted: true`. Full container IDs, state, event timestamps and diagnostics are preserved in the [case study](https://github.com/link-foundation/start/tree/issue-209-e3ae560c4c7c/docs/case-studies/issue-209).

For deployments awaiting the release, query Docker promptly with `docker events --since <FinishedAt-60s> --until <FinishedAt+1s> --filter container=<full-id> --filter event=oom --format '{{.Time}}'`, correlate only an exit 137 with an event within three seconds before / one second after finish, and keep exact-container daemon-restart evidence ahead of OOM attribution. Docker's 256-event history can be evicted, so preserve the finding at completion. An old sticky OOM flag or peak alone still does not explain a later external kill.

Suggested downstream policy remains to consume attributed `exitReason` / `memoryExhausted`, including each `attemptHistory` entry, rather than infer a fatal OOM from `OOMKilled && exitCode === 137`. The upstream change also preserves terminal evidence through recovery and applies `--on-kill-resume-memory` when the final sampled delta is missing. Event correlation is container-level evidence rather than victim-PID proof; coincident child OOM and external SIGKILL remain ambiguous.
