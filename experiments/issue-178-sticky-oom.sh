#!/bin/sh
# Issue #178: evaluate the kill decision for the (exitCode, OOMKilled) pairs
# from the issue, in the JS module and in the watcher's shell condition.
# Before the fix, (0, true) and (1, true) were treated as kills.
set -e
cd "$(dirname "$0")/../js"
node -e "
const r = require('./src/lib/execution-recovery.js');
const { SHELL_VARS } = require('./src/lib/docker-post-mortem.js');
const { spawnSync } = require('child_process');
const snippet = r.buildRecoverySnippet('uuid');
const condition = snippet.slice(0, snippet.indexOf('; }; } && ') + 6);
for (const [code, oom] of [[137, 'false'], [1, 'true'], [0, 'true'], [1, 'false'], [137, 'true'], [-1, 'true']]) {
  const script = SHELL_VARS.exit + '=' + code + '; ' + SHELL_VARS.oom + '=' + oom + '; if ' + condition + '; then echo RECOVER; else echo no recovery; fi';
  const shell = spawnSync('sh', ['-c', script], { encoding: 'utf8' }).stdout.trim();
  console.log('isKilledExit(' + code + ', ' + JSON.stringify(oom) + ') =', r.isKilledExit(code, oom), '| watcher:', shell);
}
"
