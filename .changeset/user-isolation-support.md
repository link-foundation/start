---
'start-command': minor
---

Add user isolation support with --user and --keep-user options

Implements user isolation that creates a new isolated user to run commands:

## --user option (create isolated user with same permissions)

- Add --user, -u option to create a new isolated user automatically
- New user inherits group memberships from current user (sudo, docker, wheel, etc.)
- User is automatically deleted after command completes (unless --keep-user)
- Works with screen and tmux isolation backends (not docker)
- Optional custom username via --user=myname or -u myname
- For screen/tmux: Wraps commands with sudo -n -u <user>
- Requires sudo NOPASSWD configuration for useradd/userdel/sudo

## --keep-user option

- Add --keep-user option to prevent user deletion after command completes
- Useful when you need to inspect files created during execution
- User must be manually deleted with: sudo userdel -r <username>

## Other improvements

- Add comprehensive tests for user isolation
- Update documentation with user isolation examples
- Integrate --keep-alive and --auto-remove-docker-container from main branch

Usage:

- $ --user -- npm test # Auto-generated username, auto-deleted
- $ --user myrunner -- npm start # Custom username
- $ -u myrunner -- npm start # Short form
- $ --isolated screen --user -- npm test # Combine with process isolation
- $ --user --keep-user -- npm test # Keep user after completion

Note: User isolation requires sudo NOPASSWD configuration.
