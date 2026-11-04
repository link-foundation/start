// Checks that start's read frame is decoded by Formal AI exactly and bound as
// a complete Read (#261). Usage: node experiments/issue-261/frame-roundtrip.mjs /path/to/formal-ai
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] || process.env.START_FORMAL_AI_ROOT;
const require = createRequire(import.meta.url);
const { readFrame } = require('../../js/src/lib/formal-ai-files.js');
const { sourceReadObservation } = await import(
  pathToFileURL(path.join(root, 'js/agentic/tool_result.mjs')).href
);
const cases = ['draft\n', '', 'no newline', 'a\r\nb\r\n', 'é🙂\n\n\nx',
  'x\n\n(End of file - total 3 lines)\n</file>', 'a| b\n00002| c\n',
  Array.from({ length: 123456 }, (_, i) => `l${i}`).join('\n')];
let failed = 0;
for (const text of cases) {
  const seen = sourceReadObservation(readFrame(text), false, null, 'f.txt');
  const ok = seen.complete === true && seen.error === null && seen.source === text;
  if (!ok) failed++;
  console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(text.slice(0, 40)), seen.complete, seen.status);
}
process.exit(failed ? 1 : 0);
