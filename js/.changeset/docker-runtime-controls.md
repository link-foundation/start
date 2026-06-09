---
'start-command': minor
---

Add Docker isolation runtime controls: `--volume`/`-v`, `--mount`, `--env`/`-e`, and `--privileged`. These are threaded into the underlying `docker run` invocation and recorded in `--status`/`--list` metadata, allowing callers to mount tool credentials, pass environment variables, and run Docker-in-Docker images without wrapping `docker run` themselves.
