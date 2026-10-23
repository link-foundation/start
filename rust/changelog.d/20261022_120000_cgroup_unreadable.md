---
bump: patch
---

Stop the Docker cgroup sampler when the counters can never be read (#247): exit 3 (unreadable counters, no delegated `memory` controller) from the long-lived stream or from the per-round read records the reason and stops, as exit 126/127 already did, instead of one `docker exec` and one `docker inspect -f {{.State.Running}}` per interval for the whole run. Other failed rounds back off exponentially, up to 60 s or the interval if longer; a sample restores the interval.
