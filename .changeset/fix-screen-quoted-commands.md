---
'start-command': patch
---

fix: Screen isolation output not captured for quoted commands

This fixes issue #25 where commands with quoted strings (e.g., echo "hello") would not show their output when using screen isolation. The fix uses spawnSync with array arguments instead of execSync with a constructed string to avoid shell quoting issues.
