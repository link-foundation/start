#!/usr/bin/env node
/** Regenerate executable Rust through meta-language, then compare the bytes. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(
  readFileSync(resolve(root, 'parity/translation.json'))
);
const upstream = resolve(root, '.translation/meta-language');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: upstream,
  encoding: 'utf8',
}).trim();
if (revision !== config.revision) {
  throw new Error(
    `Expected meta-language ${config.revision}; run setup-translation.mjs`
  );
}
const { selfTranslate } = await import(
  pathToFileURL(resolve(upstream, 'js/src/self-translation.js'))
);
for (const entry of config.generated) {
  const source = readFileSync(resolve(root, entry.javascript), 'utf8');
  const translated = selfTranslate(source, 'JavaScript', 'Rust');
  const carried = translated.items.filter(
    (item) => !['translated', 'kept'].includes(item.status)
  );
  if (carried.length) {
    throw new Error(
      `${entry.javascript} is not executable translation: ${JSON.stringify(carried)}`
    );
  }
  const output = `// Generated from ${entry.javascript} by meta-language ${revision}.\n// Do not edit: run node scripts/generate-rust.mjs.\n${translated.code}`;
  const destination = resolve(root, entry.rust);
  if (process.argv.includes('--check')) {
    if (readFileSync(destination, 'utf8') !== output) {
      throw new Error(`${entry.rust} drifted; regenerate from JavaScript`);
    }
  } else {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, output);
  }
  console.log(
    `${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${entry.rust}`
  );
}
