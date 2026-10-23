---
bump: patch
---

Sanitize `--upload-log` logs and auto-reported issue text with the `sensitive-data-sanitizer` CLI from `@link-foundation/sensitive-data-sanitizer` (#250) instead of the built-in rules, which removed content that is not secret (#249): the rest of a line after `Authorization:`, every URL with a port, and words containing `sk-`. The CLI is found via `START_SENSITIVE_DATA_SANITIZER` or on PATH. A manual upload installs it with bun or npm if it is missing. Without it, an automatic upload is blocked with `Log sanitization failed (ERR_UNAVAILABLE); upload blocked.` Requires Node.js 22.13 or later.
