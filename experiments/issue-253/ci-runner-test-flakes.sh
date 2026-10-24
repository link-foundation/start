#!/usr/bin/env bash
# Reproduces the two JS test failures seen on the new CI runners (#253).
# 1. ubuntu-26.04: regression-187 snapshot resumes read the free disk of
#    os.tmpdir() (10 GiB reserve). A small TMPDIR shows the dependence.
#    (Tests that execute stubs from TMPDIR also fail there: /dev/shm is noexec.)
# 2. macos-26: regression-224 held the lock only 200 ms past the waiter's
#    first 1 s poll, so a slow runner read no holder name. A 20 ms margin
#    reproduces "snapshot of another container".
set -u
cd "$(dirname "$0")/../../js"
small=$(mktemp -d /dev/shm/start-253-XXXXXX)
TMPDIR="$small" bun test ./test/regression-187.js 2>&1 | grep -E '\(fail\)|^ *[0-9]+ (pass|fail)'
rm -rf "$small"
sed "s/'task-a', 3000)/'task-a', 1020)/" test/regression-224.js > test/tmp-race-224.js
bun test ./test/tmp-race-224.js -t 'snapshot lock' 2>&1 | grep -E '\(fail\)|Received:'
rm -f test/tmp-race-224.js
