---
'start-command': minor
---

Add --keep-alive option for isolation environments

- All isolation environments (screen, tmux, docker) now automatically exit after command completion by default
- New --keep-alive (-k) flag keeps the isolation environment running after command completes
- Add ARCHITECTURE.md documentation describing system design
- Update REQUIREMENTS.md with new option and auto-exit behavior documentation
