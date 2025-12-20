---
'start-command': minor
---

Add process isolation support with --isolated option

This release adds the ability to run commands in isolated environments:

**New Features:**

- `--isolated` / `-i` option to run commands in screen, tmux, zellij, or docker
- `--attached` / `-a` and `--detached` / `-d` modes for foreground/background execution
- `--session` / `-s` option for custom session names
- `--image` option for Docker container image specification
- Two command syntax patterns: `$ [options] -- [command]` or `$ [options] command`

**Supported Backends:**

- GNU Screen - classic terminal multiplexer
- tmux - modern terminal multiplexer
- zellij - modern terminal workspace
- Docker - container isolation

**Examples:**

```bash
$ --isolated tmux -- npm start
$ -i screen -d npm start
$ --isolated docker --image node:20 -- npm install
```
