# User Isolation Research

## Issue #30: Support user isolation

### Understanding the Requirement

Based on the issue description:

> We need to find a way to support not only isolation in screen, but also isolation by user at the same time.

This suggests that the tool should support:

1. Running commands in isolated environments (screen, tmux, docker) - **ALREADY IMPLEMENTED**
2. Running commands as different users - **NEW FEATURE NEEDED**
3. Combining both types of isolation

### Related Issues

- Issue #31: Support ssh isolation (execute commands on remote ssh servers)
- Issue #9: Isolation support (closed - implemented screen/tmux/docker)

### Use Cases for User Isolation

1. **Running as a different local user:**

   ```bash
   $ --user john -- npm install   # Run npm install as user 'john'
   $ --user www-data -- node server.js  # Run server as www-data
   ```

2. **Combining user isolation with screen isolation:**

   ```bash
   $ --isolated screen --user john -- npm start
   # Run as user 'john' in a screen session
   ```

3. **Security/permission testing:**
   ```bash
   $ --user nobody -- ./test-unprivileged.sh
   # Test scripts with minimal permissions
   ```

### Implementation Options

#### Option 1: Using `sudo -u`

```bash
sudo -u <username> <command>
```

Pros:

- Simple and widely available
- Works on all Unix-like systems
- Can be combined with existing isolation

Cons:

- Requires sudo permissions
- May prompt for password (unless NOPASSWD configured)

#### Option 2: Using `su`

```bash
su - <username> -c '<command>'
```

Pros:

- Standard Unix tool
- Fully switches user context

Cons:

- Requires root or password
- More complex to use programmatically

#### Option 3: Using `runuser` (Linux)

```bash
runuser -u <username> -- <command>
```

Pros:

- Designed for this purpose
- No password prompts when run as root

Cons:

- Linux-specific
- Still requires privileges

### Proposed Design

Add new options:

- `--user <username>` or `-u <username>`: Run command as specified user
- `--user-group <group>` or `-g <group>`: Also specify group (optional)

Example usage:

```bash
# Simple user isolation
$ --user john -- npm start

# User isolation with screen
$ --isolated screen --user john -- npm start

# User isolation with docker (user mapping)
$ --isolated docker --image node:20 --user 1000:1000 -- npm install

# Detached screen with user isolation
$ --isolated screen --detached --user www-data -- node server.js
```

### Implementation Strategy

1. Add `--user` option to args-parser
2. Wrap command execution with `sudo -u` when `--user` is specified
3. Handle different isolation backends:
   - **screen/tmux**: Wrap the command with `sudo -u <user> <original-command>`
   - **docker**: Use Docker's `--user` flag (already supported by Docker)
4. Add tests for user isolation
5. Update documentation

### Challenges

1. **Password prompts**: Need to handle sudo password prompts gracefully
2. **Permission requirements**: User running `$` must have sudo rights
3. **Environment variables**: User's environment may need to be preserved/changed
4. **Path resolution**: Different users have different PATHs
5. **File permissions**: Log files need appropriate permissions

### Questions to Answer

1. Should we require NOPASSWD sudo configuration, or handle password prompts?
2. Should we preserve the original user's environment or use the target user's environment?
3. How should log file permissions be handled when running as different user?
4. Should we support root user specifically, or any user?
