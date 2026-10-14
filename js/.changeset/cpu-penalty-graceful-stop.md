---
'start-command': patch
---

`--cpu-penalty`: `penalizedMs` keeps the time since the last monitor tick when a graceful stop or a supervisor override ends a penalty, so it never decreases (#218).
