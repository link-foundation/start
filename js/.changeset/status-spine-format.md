---
'start-command': minor
---

Replace fixed-width box output with status spine format

- Width-independent output that doesn't truncate or create jagged boxes
- All metadata visible and copy-pasteable (log paths, session IDs)
- Works uniformly in TTY, tmux, SSH, CI, and log files
- Clear visual distinction: │ for metadata, $ for command, no prefix for output
- Result markers ✓ and ✗ for success/failure
- Isolation metadata repeated in footer for context
