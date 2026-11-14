#!/usr/bin/env sh
# Issue #265: `$ --stop <uuid>` on a detached docker execution must let a
# program that cleans up on SIGTERM finish. The command below needs 15 s to
# shut down cleanly; Docker's default `docker stop` grace period is 10 s.
#
# Usage: [LAUNCH_ARGS=...] [STOP=docker] experiments/issue-265/repro.sh [extra --stop arguments...]
#   repro.sh                                  # before the fix: exit 137 after ~10 s
#   repro.sh --stop-timeout 30                # after the fix: exit 0, cleanup-done
#   LAUNCH_ARGS="--stop-timeout 30" repro.sh  # recorded at launch, used by --stop
#   LAUNCH_ARGS="--stop-timeout 30" STOP=docker repro.sh  # plain `docker stop` honors it
#   START_DOCKER_STOP_TIMEOUT=30 repro.sh     # environment default
# Needs docker and pulls alpine:3. Uses a throwaway execution store.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLI="node $ROOT/js/src/bin/cli.js"
export START_APP_FOLDER="${START_APP_FOLDER:-$(mktemp -d)}"
export START_DISABLE_AUTO_ISSUE=1 START_DISABLE_LOG_UPLOAD=1
NAME="issue-265-repro-$$"

# shellcheck disable=SC2086
$CLI --isolated docker --image alpine:3 --detached --session "$NAME" ${LAUNCH_ARGS:-} -- \
  sh -c 'trap "echo cleanup-start; sleep 15; echo cleanup-done; exit 0" TERM; echo ready; while :; do sleep 1; done' \
  >/dev/null
sleep 3
START=$(date +%s)
echo "container StopTimeout: $(docker inspect -f '{{.Config.StopTimeout}}' "$NAME")"
if [ "${STOP:-}" = docker ]; then
  docker stop "$NAME" >/dev/null
else
  $CLI --stop "$NAME" "$@"
fi
END=$(date +%s)
echo "--stop returned after $((END - START))s"
echo "exit code: $(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
docker logs "$NAME" 2>&1 | grep -E 'ready|cleanup' || true
docker rm -f "$NAME" >/dev/null 2>&1 || true
