---
'start-command': minor
---

feat: Add shell auto-detection and --shell option for isolation environments

In docker/ssh and other applicable isolation environments, the shell is now
automatically detected in order of preference: `bash` → `zsh` → `sh`.

Previously, `/bin/sh` was hardcoded in Docker and SSH isolation, which prevented
access to tools like `nvm` that require bash. Now, the most feature-complete
available shell is used automatically.

Key features:

- Auto-detect best available shell in Docker containers and SSH hosts (`bash > zsh > sh`)
- New `--shell` option to force a specific shell (`auto`, `bash`, `zsh`, `sh`)
- Default mode is `auto` — no need to specify `--shell` for automatic detection
- `--shell` is passed through in isolation stacking

Example usage:

```bash
# Auto-detect best shell (default behavior, no option needed)
$ --isolated docker --image node:20 -- nvm use 20

# Force bash explicitly
$ --isolated docker --image ubuntu:22.04 --shell bash -- echo $BASH_VERSION

# Use sh specifically
$ --isolated ssh --endpoint user@host --shell sh -- echo hello
```
