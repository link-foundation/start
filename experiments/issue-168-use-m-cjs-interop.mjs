#!/usr/bin/env node

/**
 * Issue #168 — reproduces the CI/CD release failure "$ is not a function".
 *
 * Run with several Node versions to see the difference:
 *
 *   node experiments/issue-168-use-m-cjs-interop.mjs              # local node
 *   /tmp/node-v24.19.0-linux-x64/bin/node experiments/issue-168-use-m-cjs-interop.mjs
 *
 * Observed:
 *   node v20.20.2  namespace keys: [ 'default' ]                    -> use-m unwraps, $ works
 *   node v24.19.0  namespace keys: [ 'default', 'module.exports' ]  -> use-m returns the
 *                                                                     namespace, $ is undefined
 *
 * Node >= 22.12 adds the `module.exports` named export whenever
 * cjs-module-lexer cannot statically infer the exports of a CommonJS file,
 * which is the case for command-stream's src/$.cjs.
 */

import { resolveNamedExport } from '../scripts/load-command-stream.mjs';

const { use } = eval(
  await (await fetch('https://unpkg.com/use-m/use.js')).text()
);

const loaded = await use('command-stream');

console.log('node version      :', process.version);
console.log('use-m returned    :', typeof loaded);
console.log('keys              :', Object.keys(loaded));
console.log('typeof loaded.$   :', typeof loaded.$);

const resolved = resolveNamedExport(loaded, '$', 'command-stream');
console.log('typeof resolved.$ :', typeof resolved.$);

const out = await resolved.$`echo issue-168-ok`.run({ capture: true });
console.log('command output    :', out.stdout.trim());
