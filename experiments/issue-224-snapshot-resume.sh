#!/usr/bin/env sh
# Issue #224: a supervised Docker snapshot resume against a real Docker daemon.
#
# 1. Runs a failing detached command (its container is kept), then holds the
#    snapshot lock elsewhere and shows that `--resume` exits 75 at once, and
#    that `--snapshot-wait` waits for the holder instead.
# 2. A 100 TiB --snapshot-size-hint fails the disk preflight with exit 75,
#    after polling for --snapshot-disk-wait seconds when that is given.
# 3. Resumes with --snapshot-prepare (deletes a junk file before the commit),
#    --snapshot-size-hint and --remove-original-after; the log shows the
#    progress lines and the original is removed after the window.
# 4. `--cleanup <session>` retains the still-running replacement (nothing is
#    forced, exit 1); once it exits, `--cleanup-dry-run` lists and `--cleanup`
#    removes the chain's containers and then its snapshot image.
#
# `docker start` reruns the original command, so prepare only suits commands
# that are safe to rerun; this one skips its write when /junk already exists
# and stays up for 3s so the exec can run.
#
# A `--label` on the resume forces the snapshot path for a container that
# would otherwise be restarted in place.
#
# Usage: experiments/issue-224-snapshot-resume.sh [js|rust]
set -u
edition=${1:-js}
root=$(cd "$(dirname "$0")/.." && pwd)
if [ "$edition" = rust ]; then
  start() { "${START_RUST_BIN:-$root/.cargo-target/debug/start}" "$@"; }
else
  start() { node "$root/js/src/bin/cli.js" "$@"; }
fi
name=snapshot-guard-demo-$edition
app=$(mktemp -d)
export START_APP_FOLDER="$app"
export START_SNAPSHOT_LOCK="$app/snapshot.lock"
export START_SNAPSHOT_PROGRESS_INTERVAL=0.2
cleanup() {
  docker rm -f "$name" "$name-resume-1" >/dev/null 2>&1
  docker rmi "start-command-resume/$name:1" >/dev/null 2>&1
  rm -rf "$app"
}
trap cleanup EXIT

wait_final() {
  i=0
  while [ $i -lt 60 ]; do
    # Only the top-level status: resumes keep earlier runs, also "executed".
    start --status "$1" --output-format json 2>/dev/null |
      node -e 'process.exit(JSON.parse(require("fs").readFileSync(0)).status === "executed" ? 0 : 1)' &&
      return 0
    sleep 1
    i=$((i + 1))
  done
  echo "timed out waiting for $1" >&2
  return 1
}

hold_lock() {
  node -e "
    const lock = require('$root/js/src/lib/docker-snapshot-safety').acquireSnapshotLock({
      lockPath: process.env.START_SNAPSHOT_LOCK, holder: 'another-task' });
    require('fs').writeFileSync('$app/held', '1');
    setTimeout(() => { lock.release(); process.exit(0); }, $1);" &
  while [ ! -f "$app/held" ]; do sleep 0.1; done
  rm -f "$app/held"
}

echo "== launch $name (exit 1 keeps the container) =="
start --isolated docker --image alpine:3.20 --detached --session "$name" \
  -- sh -c 'test -f /junk || dd if=/dev/zero of=/junk bs=1M count=8 2>/dev/null; sleep 3; exit 1' >/dev/null
wait_final "$name"

echo "== item 1: busy lock fails fast with 75 =="
hold_lock 3000
start --resume "$name" --label demo=1 -- sh -c 'true' >/dev/null 2>"$app/err"
echo "exit code: $?"
cat "$app/err"
wait

echo "== item 2: not enough disk exits 75; --snapshot-disk-wait polls first =="
export START_SNAPSHOT_DISK_POLL=0.5
start --resume "$name" --label demo=1 --snapshot-size-hint 100t -- true >/dev/null 2>"$app/err"
echo "exit code: $?"
cat "$app/err"
started=$(date +%s)
start --resume "$name" --label demo=1 --snapshot-size-hint 100t --snapshot-disk-wait 2 -- true >/dev/null 2>"$app/err"
echo "exit code: $? after $(($(date +%s) - started))s"
tail -1 "$app/err"

echo "== items 1, 3, 5, 6, 7: wait for the lock, prepare, size hint, delayed removal =="
hold_lock 1500
start --resume "$name" --label demo=1 --snapshot-wait 30 \
  --snapshot-prepare 'rm -f /junk' --snapshot-size-hint 64m \
  --remove-original-after 2 -- sh -c 'ls /junk 2>/dev/null || echo junk-gone; sleep 8; exit 3'
echo "exit code: $?"
wait
log=$(start --status "$name" --output-format json | sed -n 's/.*"logPath": *"\([^"]*\)".*/\1/p' | head -1)
echo "-- log lines from the snapshot:"
grep -E '^\[Resume\]|Stopped original|Original container' "$log"
echo "-- original container: $(docker inspect -f '{{.State.Status}}' "$name" 2>&1)"
echo "-- replacement label: $(docker inspect -f '{{index .Config.Labels "start-command.snapshot-image"}}' "$name-resume-1")"
sleep 2
echo "-- replacement output: $(docker logs "$name-resume-1" 2>&1 | head -1)"

echo "== item 4: cleanup of the execution =="
start --cleanup "$name"
echo "cleanup while running exit code: $?"
wait_final "$name"
start --cleanup-dry-run "$name"
echo "dry run exit code: $?"
start --cleanup "$name"
echo "cleanup exit code: $?"
echo "-- image left: $(docker image inspect "start-command-resume/$name:1" >/dev/null 2>&1 && echo yes || echo no)"
start --status "$name" | grep -E 'containerState'
