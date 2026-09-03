---
'start-command': patch
---

Fix the release automation breaking on Node 24 with `$ is not a function`. `use-m` returns the raw CommonJS namespace `{ default, 'module.exports' }` instead of the callable default, so `const { $ } = await use('command-stream')` destructured `undefined` and every release job died at its first shell command. All eight affected scripts now go through the shared `scripts/load-command-stream.mjs` loader, which resolves either namespace shape and, when it cannot, throws an error naming the keys it actually saw.
