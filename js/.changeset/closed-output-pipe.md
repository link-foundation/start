---
'start-command': patch
---

A closed stdout/stderr pipe (`$ -- cmd | head -1`) no longer crashes start with an unhandled `EPIPE` and exit code 1: the command keeps running, its log and record are written, and start exits with the command's own exit code (#222).
