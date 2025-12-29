---
'start-command': minor
---

Use command-stream library for command execution in CLI

This update integrates the command-stream library to handle command execution, replacing direct usage of execSync and spawnSync in the main CLI flow. The change provides a more consistent API for running shell commands and better output handling.

Key changes:

- Added command-stream as a dependency
- Created a wrapper module for async command execution utilities
- Refactored printVersion(), runDirect(), and detectRepository() to use command-stream
- Converted main CLI flow to async for proper integration
