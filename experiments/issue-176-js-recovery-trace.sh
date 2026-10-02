#!/bin/sh
# Issue #176: trace one --on-kill-resume recovery with the JS CLI against a real
# Docker daemon: the watcher processes, the container state and the log after
# a single `docker kill`.
set -u
START=${1:-/tmp/start-js}
APP=$(mktemp -d)
export START_APP_FOLDER="$APP"
NAME="issue-176-trace-$$"
"$START" --isolated docker --image alpine:3.23 --detached --session "$NAME" \
  --on-kill-resume 2 --recovery-command 'echo "recovered attempt $START_COMMAND_RECOVERY_ATTEMPT"; sleep 300' \
  -- 'echo main; sleep 300' >/dev/null
sleep 2
echo "== watchers before kill"; ps -eo pid,pgid,args | grep -E "docker (logs|wait)|execution-recovery|internal-recover" | grep "$NAME\|recover" | grep -v grep
docker kill "$NAME" >/dev/null; sleep 4
echo "== state"; docker inspect -f 'running={{.State.Running}} started={{.State.StartedAt}} exit={{.State.ExitCode}}' "$NAME"
echo "== watchers after kill"; ps -eo pid,pgid,args | grep -E "docker (logs|wait)|execution-recovery|internal-recover" | grep "$NAME\|recover" | grep -v grep
echo "== docker logs"; docker logs "$NAME" 2>&1 | tail -3
LOG=$("$START" --status "$NAME" | sed -n 's/^ *logPath *//p' | tr -d "'\"")
echo "== log tail"; sed -n '/Recovery/,$p' "$LOG"
docker rm -f "$NAME" >/dev/null 2>&1
rm -rf "$APP"
