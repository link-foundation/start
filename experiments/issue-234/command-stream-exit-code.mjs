#!/usr/bin/env node
// Does command-stream's `$` reject on a non-zero exit? (issue #234)
// Usage: node experiments/issue-234/command-stream-exit-code.mjs
import { loadCommandStream } from '../../scripts/load-command-stream.mjs';

const { use } = eval(
  await (await fetch('https://unpkg.com/use-m/use.js')).text()
);
const { $ } = await loadCommandStream(use);

try {
  const result = await $`sh -c 'echo publish failed >&2; exit 7'`;
  console.log(`resolved: code=${result.code} (no exception)`);
} catch (error) {
  console.log(`rejected: ${error.message}`);
}
try {
  const result = await $`sh -c 'exit 7'`.run({ capture: true, mirror: false });
  console.log(`run({capture}) resolved: code=${result.code}`);
} catch (error) {
  console.log(`run({capture}) rejected: ${error.message}`);
}
