---
'start-command': patch
---

Treat Docker `OOMKilled` as an observation rather than a verdict in `--status` / `--list`: a detached session whose container is still running stays `executing` (with `oomKilled true` alongside), a stopped container reports its real `.State.ExitCode`, and `137` is used only when the container is gone and neither a log footer nor an exit code can be recovered.
