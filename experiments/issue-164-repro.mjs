#!/usr/bin/env bun
// Reproduction harness for issue #164: argv boundaries lost by commandArgs.join(' ')
import { spawnSync } from 'child_process';
import path from 'path';

const cli = path.join(import.meta.dir ?? process.cwd(), '..', 'js/src/bin/cli.js');
const cases = [
  ['node', '-e', "console.log('hi')"],
  ['echo', 'a  b'],
  ['bash', '-c', 'echo hello world'],
  ['bash', '-c', 'echo $((1+1))'],
  ['ls | wc -l'],
  ['git', 'log', '-1', '--pretty=%s'],
];
for (const argv of cases) {
  const r = spawnSync('bun', [cli, ...argv], { encoding: 'utf8', env: { ...process.env, START_DISABLE_SUBSTITUTIONS: '1' } });
  const body = (r.stdout || '').split('\n');
  console.log('argv:', JSON.stringify(argv), '=> exit', r.status);
  console.log(body.slice(0, 8).map((l) => '   ' + l).join('\n'));
}
