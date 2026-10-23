---
'start-command': patch
---

Attached `--isolated screen` runs no longer report a failed command as exit 0 when `screen -dmS` returns before `screen -ls` lists the new session. A session missing from `screen -ls` now counts as finished only once its exit-code file is written, or after 20 polls (about 2 s) without the session.
