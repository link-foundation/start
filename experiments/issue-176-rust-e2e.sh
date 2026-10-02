#!/bin/sh
# End-to-end check of issue #176 against a real Docker daemon with the Rust
# binary (pass another `start` binary as $1, e.g. the JS CLI, to compare).
#   1. --on-kill-resume / --recovery-command: `docker kill` the main process,
#      the watcher resumes the same container with the recovery command.
#   2. --resume <id> -- <cmd>: a `docker update --pids-limit` limit survives
#      the docker commit + docker run snapshot resume.
set -u
START=${1:-"$(dirname "$0")/../rust/target/debug/start"}
APP=$(mktemp -d)
export START_APP_FOLDER="$APP"
NAME="issue-176-e2e-$$"

echo "== launch"
"$START" --isolated docker --image alpine:3.23 --detached --session "$NAME" \
  --on-kill-resume 2 --recovery-command 'echo "recovered attempt $START_COMMAND_RECOVERY_ATTEMPT"; sleep 300' \
  -- 'echo main; sleep 300'
sleep 2
docker update --pids-limit 64 "$NAME" >/dev/null
echo "== kill 1"; docker kill "$NAME" >/dev/null; sleep 4
docker inspect -f 'running={{.State.Running}} pids={{.HostConfig.PidsLimit}}' "$NAME"
echo "== kill 2"; docker kill "$NAME" >/dev/null; sleep 4
docker inspect -f 'running={{.State.Running}}' "$NAME"
echo "== kill 3 (attempts used up)"; docker kill "$NAME" >/dev/null; sleep 4
docker inspect -f 'running={{.State.Running}}' "$NAME"
echo "== status"; "$START" --status "$NAME" | grep -Ei 'status|exitCode|recovery|onKill|resourceLimits'
LOG=$("$START" --status "$NAME" | sed -n 's/^ *logPath *//p' | tr -d "'\"")
echo "== log ($LOG)"; cat "$LOG"

echo "== snapshot resume"
"$START" --resume "$NAME" -- 'cat /proc/self/cgroup >/dev/null; sleep 30'
sleep 2
docker inspect -f 'resume-1 pids={{.HostConfig.PidsLimit}}' "$NAME-resume-1"

docker rm -f "$NAME" "$NAME-resume-1" >/dev/null 2>&1
docker rmi "start-command-resume/$NAME:1" >/dev/null 2>&1
rm -rf "$APP"
