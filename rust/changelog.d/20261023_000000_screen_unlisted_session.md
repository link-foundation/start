---
bump: patch
---

Attached screen isolation no longer reports a failed command as exit 0 when `screen -dmS` returns before `screen -ls` lists the new session: a missing session counts as finished only once its exit-code file is written, or after 20 polls (about 2 s) without it.
