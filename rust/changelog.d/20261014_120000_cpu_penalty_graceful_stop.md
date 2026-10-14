---
bump: patch
---

`--cpu-penalty`: a graceful stop (SIGTERM/SIGINT) lifts the cap within a fraction of a second instead of waiting out the monitor tick of up to 30 s (#219), and `penalizedMs` keeps the time since the last tick when a graceful stop or a supervisor override ends a penalty (#218).
