---
'start-command': patch
---

Treat detached Docker sessions with `oomKilled` as terminal in status output, using Docker's exit code when available and 137 as the OOM fallback.
