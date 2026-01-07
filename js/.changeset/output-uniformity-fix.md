---
'start-command': patch
---

fix: Improve output uniformity and ensure echo hi works in all modes

- Fixed truncation of log paths, session IDs, and result messages in output blocks
- Added consistent empty line formatting before/after command output
- Ensured proper output display in screen isolation mode
- Added integration tests for echo command across all isolation modes
