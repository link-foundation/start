---
'start-command': minor
---

feat: Improve command output formatting with human-readable timestamps and duration

- Changed timestamp format from `[timestamp] Starting:` to `Starting at timestamp:`
- Changed finish message from `[timestamp] Finished` to `Finished at timestamp in X.XXX seconds`
- Added performance metric showing command execution duration
- Added `formatDuration` helper function for consistent duration formatting
