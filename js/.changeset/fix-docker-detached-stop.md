---
'start-command': patch
---

Use `docker stop` for detached Docker `--stop` control so containers follow Docker's graceful stop lifecycle instead of receiving a raw `SIGINT`.
