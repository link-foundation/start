# User Isolation Research

## Issue #30: Support user isolation

### Understanding the Requirement

Based on the issue description:

> We need to find a way to support not only isolation in screen, but also isolation by user at the same time.

And the clarification from the user:

> No, there is no way to use existing user to run the command, user isolation should mean we create user - run command using this user, after command have finished we can delete user, unless we have `--keep-user` option.

This means:

1. Running commands in isolated environments (screen, tmux, docker) - **ALREADY IMPLEMENTED**
2. Creating new isolated users with same permissions as current user - **IMPLEMENTED**
3. Automatic cleanup of isolated users after command completes - **IMPLEMENTED**
4. Option to keep the user (`--keep-user`) - **IMPLEMENTED**

### Related Issues

- Issue #31: Support ssh isolation (execute commands on remote ssh servers)
- Issue #9: Isolation support (closed - implemented screen/tmux/docker)

### Final Implementation

The `--isolated-user` option creates a new isolated user with the same group memberships as the current user:

```bash
# Create isolated user and run command (user auto-deleted after)
$ --isolated-user -- npm test

# Custom username for isolated user
$ --isolated-user myrunner -- npm start
$ -u myrunner -- npm start

# Combine with screen isolation
$ --isolated screen --isolated-user -- npm test

# Combine with tmux detached mode
$ -i tmux -d --isolated-user testuser -- npm run build

# Keep user after command completes
$ --isolated-user --keep-user -- npm test
```

### How It Works

1. **User Creation**
   - Creates new system user with same group memberships as current user
   - Inherits sudo, docker, wheel, admin, and other groups
   - Uses `sudo useradd` with `-G` flag for groups

2. **Command Execution**
   - For screen/tmux: Wraps command with `sudo -n -u <user>`
   - For standalone (no isolation backend): Uses `sudo -n -u <user> sh -c '<command>'`

3. **Cleanup**
   - After command completes, user is deleted with `sudo userdel -r <user>`
   - Unless `--keep-user` flag is specified

### Requirements

- `sudo` access with NOPASSWD configuration for:
  - `useradd` - to create the isolated user
  - `userdel` - to delete the isolated user
  - `sudo -u` - to run commands as the isolated user

### Benefits

- Clean user environment for each run
- Inherits sudo/docker access from current user
- Files created during execution belong to isolated user
- Automatic cleanup after execution (unless --keep-user)
- Prevents untrusted code from affecting your user's files

### Limitations

- Not supported with Docker isolation (Docker has its own user isolation mechanism)
- Requires sudo NOPASSWD configuration
- Only works on Unix-like systems (Linux, macOS)
