---
'start-command': patch
---

Fix the release automation breaking on Node 24 with `$ is not a function`. `use-m` returns the raw CommonJS namespace `{ default, 'module.exports' }` instead of the callable default, so `const { $ } = await use('command-stream')` destructured `undefined` and every release job died at its first shell command. All eight affected scripts now go through the shared `scripts/load-command-stream.mjs` loader, which resolves either namespace shape and, when it cannot, throws an error naming the keys it actually saw.

Also hardens every external command the package spawns. `failure-handler` and
`ExecutionStore.execClink` interpolated data - the failing command's own name,
the log path, recorded command text - into shell strings; they now pass an
argument vector, so a backtick, `$(...)` or `'` in a command is no longer
executed by a shell. As part of that, `gh issue create` receives the report
body verbatim: its newlines previously reached GitHub as the two characters
`\n`. Session ids and isolation usernames are now drawn from `crypto` rather
than `Math.random()`.
