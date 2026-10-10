#!/usr/bin/env node
/** Pin upstream semantic translation; the published 0.46.0 lacks selfTranslate. */
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(
  readFileSync(resolve(root, 'parity/translation.json'))
);
const destination = resolve(root, '.translation/meta-language');
mkdirSync(destination, { recursive: true });
const run = (program, args, cwd = destination) => {
  if (process.env.PARITY_VERBOSE === '1') {
    console.log(`[translation] ${program} ${args.join(' ')}`);
  }
  execFileSync(program, args, { cwd, stdio: 'inherit' });
};
run('git', ['init', '--quiet']);
run('git', [
  'fetch',
  '--quiet',
  '--depth',
  '1',
  config.repository,
  config.revision,
]);
run('git', ['checkout', '--quiet', '--detach', config.revision]);
run(
  'bun',
  ['install', '--production', '--frozen-lockfile'],
  resolve(destination, 'js')
);
console.log(`Prepared meta-language ${config.revision}`);
