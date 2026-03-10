---
'start-command': patch
---

fix: show helpful error message when Docker is not installed (issue #84)

When running `$ --isolated docker -- bash` and Docker is not installed on the
machine (not just "not running"), `start-command` now prints a clear error
message to stderr:

```
Error: Docker is not installed. Install Docker from https://docs.docker.com/get-docker/
```

Previously the command exited silently with code 1, giving no indication of
why it failed. The user had to manually run `which docker` to discover that
Docker was not installed at all.

Also adds `isDockerInstalled()` to `docker-utils.js` to distinguish between
"Docker CLI not found" and "Docker CLI found but daemon not running", and
exposes it via the module exports for use in tests.
