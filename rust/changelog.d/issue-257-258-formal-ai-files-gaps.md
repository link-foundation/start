---
bump: minor
---

### Changed

- `--use-formal-ai`:
  - HTTP errors from the Formal AI runtime keep a sanitized, bounded cause: error type, message, body preview, body length and attempts. The cause is in the final message and under `outcome.diagnostics` in the evidence, including after retries. Authorization values and the environment are never recorded, and the exit status stays 70 (#257).
  - Formal AI is offered structured `read`, `edit` and `write` tools under the workspace path policy, with readback verification and a new `START_FORMAL_AI_MAX_FILE_BYTES` bound. `edit` and `write` are offered only in workspace-write mode (#258).
  - Known capability-gap answers are reported as incomplete with exit 65 and keep their obligations. Plain answers still exit 0 (#258, #259).
