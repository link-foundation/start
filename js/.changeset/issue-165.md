---
'start-command': minor
---

Surface `memoryExhausted` and `memoryExhaustedReason` in `--status` when the log shows the runtime aborted on its own memory limit: a Node/V8 heap-limit abort dies below the container limit, so `oomKilled` stays `false` and the only evidence is the `FATAL ERROR` line the runtime printed. The log tail is now scanned with a 64 KiB window (V8 prints a long native stack trace after the marker), the observation covers attached sessions too, and the kept-container footer no longer asserts a bare `oomKilled=false` next to a fatal marker for exit codes 134/139.
