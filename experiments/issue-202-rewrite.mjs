#!/usr/bin/env bun
// Compare the reported argv rewriting with the exact pre-PR implementation.
import { createRequire } from 'node:module';
import Module from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const filename = resolve(root, 'js/src/lib/shell-utils.js');
const require = createRequire(filename);
const previous = new Module(filename);
previous.filename = filename;
previous.paths = require.resolve.paths('command-stream');
previous._compile(execFileSync('git', ['show', '2f4273d:js/src/lib/shell-utils.js'], { cwd: root, encoding: 'utf8' }), filename);
const current = require(filename);
for (const command of ["sh -c 'exit 7'; echo after $?", "sh -c 'echo $0 $1' a b", "sh -c 'kill -9 $$'; exit $?"]) {
  for (const [version, implementation] of [['before', previous.exports], ['after', current]]) {
    const argv = implementation.isShellInvocationWithArgs(command)
      ? implementation.buildShellWithArgsCmdArgs(command) : ['sh', '-c', command];
    const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
    console.log(JSON.stringify({ version, command, argv, stdout: result.stdout, status: result.status, signal: result.signal }));
  }
}
