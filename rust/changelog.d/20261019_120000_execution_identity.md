---
bump: minor
---

Mirror the JavaScript execution identity work: an existing explicit `--session-id` is refused unless `--append-attempt` appends a new attempt to the same record and log (#229); every backend exports `START_EXECUTION_ID`, `START_SESSION_NAME` and `START_ATTEMPT` (#230); `--alias`, `--rename` and `--continues` name executions and link them into chains that `--status` reports and `--upload-log` uploads as one log (#231).
