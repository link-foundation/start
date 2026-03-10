---
'start-command': patch
---

fix: show virtual docker pull command before Docker availability errors (issue #89)

When running `$ --isolated docker --image <image> -- <command>` and Docker is
not installed or not running, `start-command` now shows the virtual
`$ docker pull <image>` command that was being attempted before displaying the
error message.

Before:

```
│ isolation docker
│ mode      attached
│ image     konard/sandbox
│ container docker-1773150604263-i87zla
│
Error: Docker is not installed. Install Docker from https://docs.docker.com/get-docker/
```

After:

```
│ isolation docker
│ mode      attached
│ image     konard/sandbox
│ container docker-1773150604263-i87zla
│
$ docker pull konard/sandbox

✗
│

Error: Docker is not installed. Install Docker from https://docs.docker.com/get-docker/
```

This makes it clear to users what `start-command` was attempting to do and
why Docker is needed, improving the debugging experience.
