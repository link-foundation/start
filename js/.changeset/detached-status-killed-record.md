---
'start-command': patch
---

Fix `--status` for detached executions resurrecting a completed (killed) record. `enrichDetachedStatus()` no longer flips an already-`executed` record back to `executing` (and nulls its exit code) just because `screen -ls`/`tmux`/`docker` still lists a same-named session — a lingering shell can outlive a SIGKILLed command (e.g. OOM, exit 137). The recorded exit code and the `Exit Code:` log footer that `start` itself writes are now treated as authoritative; the record only flips to `executing` when there is no recorded exit code and no terminal footer in the log.
