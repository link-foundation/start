---
'start-command': minor
---

Add user isolation support with --user option

Implements user isolation feature that allows running commands as a different user. This enables both process isolation (screen/tmux/docker) and user isolation to work together.

- Add --user option to run commands as specified user
- For screen/tmux: Wraps commands with sudo -n -u <user>
- For docker: Uses Docker's native --user flag
- Add comprehensive tests for user isolation
- Update documentation with user isolation examples

Usage:

- $ --user www-data -- node server.js
- $ --isolated screen --user john -- npm start
- $ --isolated docker --image node:20 --user 1000:1000 -- npm install

Note: User isolation with screen/tmux requires sudo NOPASSWD configuration.
