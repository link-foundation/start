// Which `code` values does command-stream report? `result.code || 0` is only
// safe to replace with a stricter default if success is always a numeric 0.
import { $, raw } from '../js/node_modules/command-stream/js/src/$.mjs';
const cmds = ['echo hi', 'true', 'false', 'cd /tmp', 'echo a | cat', 'exit 3', 'sleep 0'];
for (const c of cmds) {
  const a = await $({ mirror: false, capture: true })`${raw(c)}`;
  const s = $({ mirror: false, capture: true })`${raw(c)}`.sync();
  console.log(JSON.stringify(c), 'async', typeof a.code, a.code, 'sync', typeof s.code, s.code);
}
