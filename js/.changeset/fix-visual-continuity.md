---
'start-command': patch
---

Fix visual continuity in docker isolation mode (#73)

The empty line is now properly placed after the command line (e.g., `$ docker pull alpine:latest`)
instead of before it, maintaining consistent visual structure in the timeline output.

Before:

```
│

$ docker pull alpine:latest
latest: Pulling from library/alpine
```

After:

```
│
$ docker pull alpine:latest

latest: Pulling from library/alpine
```
