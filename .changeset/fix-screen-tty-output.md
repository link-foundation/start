---
'start-command': patch
---

fix: Screen isolation output always captured in attached mode

Changed attached mode to always use log capture instead of direct screen invocation.
This ensures command output is never lost, even for quick commands that would
otherwise have their output disappear when the screen session terminates rapidly.

Fixes #25: Output from `$ --isolated screen -- echo "hello"` is now properly
displayed instead of being lost with only "[screen is terminating]" shown.
