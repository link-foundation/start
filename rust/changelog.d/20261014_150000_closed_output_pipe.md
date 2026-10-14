---
bump: patch
---

A closed stdout/stderr pipe no longer panics with "failed printing to stdout: Broken pipe" and exit code 101: `start --version | head -1` exits 0, and a command run through such a pipe keeps running and exits with its own exit code, as in the JavaScript edition (#222).
