---
'start-command': minor
---

Add SSH isolation support for remote command execution.

- Implements SSH backend for executing commands on remote servers via SSH, similar to screen/tmux/docker isolation
- Uses `--endpoint` option to specify SSH target (e.g., `--endpoint user@remote.server`)
- Supports both attached (interactive) and detached (background) modes
- Includes comprehensive SSH integration tests in CI with a local SSH server
