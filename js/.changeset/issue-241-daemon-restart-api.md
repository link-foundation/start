---
'start-command': patch
---

Attribute a Docker daemon restart without the host journal (#241). With a mounted `docker.sock` (Docker-outside-of-Docker) or a remote daemon, an exit-137 task is now reported as `killed (docker daemon restart)` when another container finished within the 15 s shutdown window with exit 137/143, or was started again after it, and was not OOM-killed. `exitEvidence.daemonRestartSource` records whether the host journal or the Docker API supported the attribution, and `--status` collects the evidence itself when the detached watcher died with the daemon before it could log any.
