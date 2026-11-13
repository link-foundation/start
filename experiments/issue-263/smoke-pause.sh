#!/usr/bin/env bash
# Smoke test for issue #263: pause/unpause a real detached docker execution.
set -u
cd "$(dirname "$0")/../../js"
export START_APP_FOLDER=$(mktemp -d) START_TEMP_ROOT=$(mktemp -d)
S=pause-smoke-$$
run() { echo "\$ $*"; timeout 60 bun src/bin/cli.js "$@"; echo "exit=$?"; }
run -i docker -d -s "$S" --image alpine:latest -- sh -c 'i=0; while true; do i=$((i+1)); echo tick $i; sleep 1; done'
sleep 3
echo "pid before: $(docker inspect -f '{{.State.Pid}}' "$S")"
run --pause "$S" --pause-reason 'rate limit' --paused-by hive-mind
run --pause "$S"
echo "docker: $(docker inspect -f '{{.State.Status}}' "$S")"
run --status "$S" --output-format text
run --list --running --output-format text
run --attach "$S"
run --resume "$S"
run --resume-all
run --cleanup "$S"
run --unpause "$S"
echo "pid after: $(docker inspect -f '{{.State.Pid}}' "$S")"
run --unpause "$S"
run --pause "$S" --output-format json
run --stop "$S"
sleep 2
run --status "$S" --output-format json
run --unpause "$S"
run --pause "$S"
run -i screen -d -s "scr-$$" -- sleep 30
run --pause "scr-$$"
screen -S "scr-$$" -X quit 2>/dev/null
docker rm -f "$S" >/dev/null 2>&1
