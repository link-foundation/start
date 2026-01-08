---
'start-command': patch
---

fix: Add empty line before result marker for visual continuity

- Added empty line before result marker (✓/✗) after command output
- Ensures consistent visual formatting: command → empty line → output → empty line → result marker
- Applied to both docker pull virtual commands and user commands
- Tests document the expected visual format

Expected format:

```
│
$ docker pull alpine:latest

latest: Pulling from library/alpine
...

✓
│
$ echo hi

hi

✓
```

Fixes #73
