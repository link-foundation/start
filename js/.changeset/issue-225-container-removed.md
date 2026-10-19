---
'start-command': patch
---

`$ --status` now reports `containerState removed` and `containerRemovedObservedAt` when the docker container of a finished detached execution no longer exists, instead of showing the old `containerId` as if the container still held its disk. The removal is recorded when start's own cleanup policy removes the container and when `--status` finds it gone; `containerId` is kept for history, and a docker daemon that cannot be reached is not mistaken for a removed container (#225).
