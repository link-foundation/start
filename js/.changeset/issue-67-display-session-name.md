---
'start-command': patch
---

fix: Always display session/container name in isolation output

When using isolation backends (screen, docker, tmux), the output now shows the actual session/container name that users need to reconnect to sessions, especially in detached mode. Previously, only the session UUID was shown, but users need the actual backend name to:

- Reconnect to detached screen sessions: `screen -r <name>`
- Attach to tmux sessions: `tmux attach -t <name>`
- View Docker container logs: `docker logs <name>`
- Remove containers: `docker rm -f <name>`

Fixes #67
