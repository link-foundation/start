---
'start-command': patch
---

Add `--on-kill-resume-delay <min[-max]>` for `--on-kill-resume`/`--recovery-command`: wait a uniformly random number of seconds (e.g. `30-90`; one number is a fixed delay, the default `0` resumes at once) before each recovery, so executions killed by the same host-wide OOM event do not all restart in the same second and trigger the next one. The chosen delay is printed in the `[Recovery k/N]` line, stored as `delayMs` in `recoveryHistory` and as `lastRecoveryDelayMs`, and shown in the `[Isolation] On kill:` line. A `--stop` or `--terminate` during the wait cancels the pending resume; `--terminate` of the already exited container now reports `recovery-cancelled` instead of failing.
