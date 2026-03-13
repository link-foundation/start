---
'start-command': patch
---

fix: display `bash -c "..."` commands with quotes in command line output (issue #91)

When a command like `bash -i -c nvm --version` was passed to Docker isolation,
the displayed command line was missing quotes around the `-c` script argument,
making the output misleading (showing `bash -i -c nvm --version` instead of
`bash -i -c "nvm --version"`).

A new `buildDisplayCommand()` helper is added in `shell-utils.js` that quotes
any space-containing `-c` script arguments so the displayed command accurately
reflects how it was interpreted. Shell command helpers are extracted from
`isolation.js` into a new `shell-utils.js` module to keep file sizes within limits.
