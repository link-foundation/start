---
'start-command': patch
---

fix: support --session name lookups in --status and track detached session lifecycle

`--status` now accepts session names in addition to UUIDs. Detached mode no longer incorrectly reports immediate completion — status is determined at query time by checking if the actual session is still running.
