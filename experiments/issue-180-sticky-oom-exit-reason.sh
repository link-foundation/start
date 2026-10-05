#!/bin/sh
# Issue #180: the (exitCode, OOMKilled) reproduction table from the issue.
# Before the fix, exit 0/1 with OOMKilled=true were reported as
# `memory-exhaustion (cgroup-oom-killer)` / `memoryExhausted: true`.
set -e
cd "$(dirname "$0")/../js"
node -e "
const { resolveExitReason, resolveMemoryExhaustion } = require('./src/lib/exit-reason.js');
for (const [exitCode, oomKilled] of [[0, true], [1, true], [1, false], [137, true], [137, false], [-1, true]]) {
  console.log('exit=' + exitCode + ' oomKilled=' + oomKilled + ' -> exitReason=' + JSON.stringify(resolveExitReason({ exitCode, oomKilled })) + ' memory=' + JSON.stringify(resolveMemoryExhaustion({ exitCode, oomKilled })));
}
"
