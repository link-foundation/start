---
'start-command': patch
---

Fix detached docker `--status`/`--list` reporting a terminal status (`executed`) with the `-1` sentinel while the container is still running (or not visible yet on a slow Docker-in-Docker host). `isDetachedSessionAlive()` now treats a failed `docker inspect` as "unknown" (returns `null`) instead of "stopped", so a session whose container has not appeared yet stays `executing` rather than being marked finished. When a container has genuinely stopped, `enrichDetachedStatus()` resolves the real exit code from the `Exit Code:` log footer and then `docker inspect .State.ExitCode`, only falling back to `-1` when no real code can be obtained.
