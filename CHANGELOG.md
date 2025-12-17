# start-command

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
