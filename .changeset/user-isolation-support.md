---
'start-command': minor
---

Add user isolation support with --user and --create-user options

Implements comprehensive user isolation features that allow running commands as different users:

## --user option (run as existing user)

- Add --user option to run commands as a specified existing user
- For screen/tmux: Wraps commands with sudo -n -u <user>
- For docker: Uses Docker's native --user flag
- Requires sudo NOPASSWD configuration for screen/tmux

## --create-user option (create isolated user with same permissions)

- Add --create-user option to create a new isolated user automatically
- New user inherits group memberships from current user (sudo, docker, wheel, etc.)
- User is automatically deleted after command completes
- Works with screen and tmux isolation backends (not docker)
- Optional custom username via --create-user=myname

## Other improvements

- Add comprehensive tests for user isolation
- Update documentation with user isolation examples
- Integrate --keep-alive and --auto-remove-docker-container from main branch

Usage:

- $ --user www-data -- node server.js
- $ --isolated screen --user john -- npm start
- $ --isolated docker --image node:20 --user 1000:1000 -- npm install
- $ --create-user -- npm test
- $ --create-user myrunner -- npm start
- $ --isolated screen --create-user -- npm test

Note: Both --user and --create-user with screen/tmux require sudo NOPASSWD configuration.
