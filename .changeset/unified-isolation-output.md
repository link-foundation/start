---
'start-command': minor
---

Unify output experience for isolation mode

- Change terminology from "Backend" to "Environment" in isolation output
- Add unified logging with timestamps for isolation modes (screen, tmux, docker, zellij)
- Save log files for all execution modes with consistent format
- Display start/end timestamps, exit code, and log file path uniformly across all modes
