// What does command-stream report for a child killed by a signal, in async and
// sync mode? `result.code || 0` would turn a null/undefined code into success.
import { $, raw } from '../js/node_modules/command-stream/js/src/$.mjs';
for (const sig of ['TERM', 'KILL', 'INT']) {
  const cmd = `sh -c 'kill -${sig} $$'`;
  const a = await $({ mirror: false, capture: true })`${raw(cmd)}`;
  const s = $({ mirror: false, capture: true })`${raw(cmd)}`.sync();
  console.log(sig, 'async', a.code, 'sync', s.code);
}
