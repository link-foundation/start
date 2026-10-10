import { selfTranslate } from '../.translation/meta-language/js/src/self-translation.js';
import { writeFileSync } from 'node:fs';
const cases = {
  arithmetic: '/** @param {number} count @returns {number} */\nexport function threshold(count) { return count * 0.9; }\n',
  runtimeImport: "import { spawnSync } from 'node:child_process';\nexport function run() { return spawnSync('echo', ['hello']); }\n",
  commonJs: "const fs = require('node:fs');\nfunction read(path) { return fs.readFileSync(path, 'utf8'); }\nmodule.exports = { read };\n",
  optional: 'export function session(options) { return options?.session ?? null; }\n',
  objects: 'export function record() { return { status: "executed", exitCode: 0 }; }\n',
  arrays: 'export function selected(values) { return values.filter(value => value > 0).join(","); }\n',
  regex: 'export function isDelay(value) { return /^(\\d+)(ms|s)$/.test(value); }\n',
  exceptions: 'export function parse(value) { try { return JSON.parse(value); } catch { return null; } }\n',
  asynchronous: 'export async function execute(run) { return await run(); }\n',
};
const results = Object.entries(cases).map(([construct, source]) => {
  try {
    const result = selfTranslate(source, 'JavaScript', 'Rust');
    return { construct, source, items: result.items.map(({ term, status, reason }) => ({ term, status, reason })), rust: result.code };
  } catch (error) {
    return { construct, source, error: error.message };
  }
});
writeFileSync('docs/case-studies/issue-197/data/translation-probe.json', `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results.map(({ construct, items, error }) => ({ construct, items, error })), null, 2));
