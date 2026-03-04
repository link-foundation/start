---
'start-command': minor
---

feat: Use interactive shell mode in isolation environments to source startup files

In docker and ssh isolation environments, bash and zsh are now invoked with
the `-i` (interactive) flag when executing commands. This ensures that startup
files like `.bashrc` and `.zshrc` are sourced, making environment-dependent
tools like `nvm`, `rbenv`, `pyenv`, and similar version managers available
in isolated commands.

Previously, even though bash was correctly detected and used over sh, running
`nvm --version` in a Docker container would fail with "command not found"
because bash was started in non-interactive mode and did not source `.bashrc`.

With this fix:

- Docker: `docker run <image> bash -i -c "nvm --version"` sources `.bashrc`
- SSH: `ssh <host> bash -i -c "nvm --version"` sources `.bashrc` on the remote host
- `zsh` also gets the `-i` flag for the same reason
- `sh` does not get `-i` as it is used as a fallback for minimal containers

Fixes #79
