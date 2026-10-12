---
'start-command': patch
---

Attribute exit 137 to recent Docker OOM events when the last cgroup sample misses the final kill. Preserve daemon restart and ordinary-exit safeguards, apply attributed evidence to recovery memory limits, and recompute each archived attempt's status diagnostics independently.
