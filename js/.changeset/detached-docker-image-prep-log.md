---
'start-command': patch
---

Record the docker image-preparation phase in the session log (issue #138). When a `--isolated docker` run needs to `docker pull` an image, the pull output is now teed into the session-log file (`/tmp/start-command/logs/isolation/docker/<uuid>.log`) in real time and bracketed with `Preparing image <name>…` / `Image ready (<duration>)` markers (or `Image preparation failed` on error). Previously the minutes spent pulling a (potentially multi-GB) image left no trace in the log, so operators tailing `$ --upload-log <uuid>` during startup saw only the header. The single session-log file is now a gap-free record of the run, including the longest, most failure-prone phase.
