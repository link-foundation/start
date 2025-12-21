# start-command

## 0.4.0

### Minor Changes

- e8bec3c: Add process isolation support with --isolated option

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

## 0.3.1

### Patch Changes

- 6a701da: Apply js-ai-driven-development-pipeline-template (Bun-only)
  - Add .changeset/ for version management
  - Add .husky/ for git hooks
  - Add eslint.config.mjs with ESLint 9 flat config
  - Add .prettierrc for code formatting
  - Add bunfig.toml for Bun configuration
  - Add scripts/ directory with release automation scripts
  - Create release.yml workflow (Bun-only, merged test.yml)
  - Add CHANGELOG.md

## 0.3.0

### Minor Changes

- Initial release with natural language command aliases
- Automatic logging of all commands
- Auto-reporting on failure for NPM packages
- GitHub integration for issue creation
