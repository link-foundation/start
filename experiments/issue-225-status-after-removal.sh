#!/usr/bin/env sh
# Issue #225: `$ --status` must say when a kept docker container was removed.
#
# Runs a failing detached command (the default cleanup policy keeps the
# container), waits for the watcher to finalize it, removes the container by
# hand and queries the status again. Then runs a succeeding command, whose
# container the watcher removes itself, and checks that removal is recorded.
#
# Usage: experiments/issue-225-status-after-removal.sh [js|rust]
set -u
edition=${1:-js}
root=$(cd "$(dirname "$0")/.." && pwd)
if [ "$edition" = rust ]; then
  start() { "${START_RUST_BIN:-$root/.cargo-target/debug/start}" "$@"; }
else
  start() { node "$root/js/src/bin/cli.js" "$@"; }
fi
app=$(mktemp -d)
export START_APP_FOLDER="$app"
trap 'docker rm -f status-removal-demo status-removal-ok >/dev/null 2>&1; rm -rf "$app"' EXIT

wait_final() {
  i=0
  while [ $i -lt 60 ]; do
    start --status "$1" --output-format json 2>/dev/null | grep -q '"status": *"executed"' && return 0
    sleep 1
    i=$((i + 1))
  done
  echo "timed out waiting for $1" >&2
  return 1
}

echo "== kept container (exit 1) =="
start --isolated docker --image alpine:3.20 --detached --session status-removal-demo \
  -- sh -c 'echo working; exit 1' >/dev/null
wait_final status-removal-demo
start --status status-removal-demo --output-format text | grep -E 'Status|Exit Code|Container' || true
echo "-- docker rm -f status-removal-demo"
docker rm -f status-removal-demo >/dev/null
start --status status-removal-demo | grep -E 'containerState|containerRemovedObservedAt|containerId'
start --status status-removal-demo --output-format text | grep -E 'Container'

echo "== container removed by the cleanup policy (exit 0) =="
start --isolated docker --image alpine:3.20 --detached --session status-removal-ok \
  -- sh -c 'echo done' >/dev/null
wait_final status-removal-ok
sleep 2
start --status status-removal-ok | grep -E 'containerState|containerRemovedObservedAt|containerId'
