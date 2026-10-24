## Summary

`import { $ } from 'command-stream'` in 2.4.0 loads 281 modules. The `src/$.mjs` entry imports these at the top level:

- the ShellJS compatibility layer, which pulls in execa,
- the Bun shell and zx layers,
- terminal capture with `@xterm/headless`,
- the Rust REPL and about 27 built-in commands.

Importing it takes 320–390 ms on top of about 75 ms for Node itself. A program that only needs `$` pays for all of these.

#192 added `command-stream/process-runner`, which avoids the native terminal dependencies, but it does not export `$`.

Found in link-foundation/start#253 while moving start-command from command-stream 0.9.5 to 2.4.0. The import time went from about 50 ms to about 240–390 ms. `node_modules` grew from about 3 MB to about 80 MB, including `@resvg/resvg-js` (8.5 MB) and the optional `node-pty` (63 MB). start already imports command-stream lazily, only for `--use-command-stream`.

## Reproduction

Node.js 22, Linux x64, command-stream 2.4.0. A `module.registerHooks` load hook counts what `await import('command-stream/src/$.mjs')` loads:

```
modules=281 ms=341
125 745 KiB command-stream (40 shelljs/, 27 commands/, 16 bun-shell/, 2 zx/, terminal-*, rust-repl, debugger-view, testing)
109 276 KiB execa
  1 178 KiB @xterm/headless
  9  11 KiB get-stream, plus signal-exit, cross-spawn, figures, human-signals, ...
```

`node --cpu-prof` puts most of the time in Node's module loader and compiler (`node-internal`: 337 ms), not in any single dependency. `@xterm/headless` alone takes 27 ms.

## Suggested fix

- Load the compatibility layers (`shelljs`, `execa`, `zx`, `bun-shell`) and the terminal, REPL and debugger modules lazily, on first use, from the main entry.
- Or publish a light entry such as `command-stream/core` that exports `$`, `ProcessRunner` and the virtual commands only.
- A CI budget would keep it that way, for example "`import { $ }` loads fewer than N modules / under X ms".
