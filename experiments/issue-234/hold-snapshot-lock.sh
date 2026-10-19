#!/usr/bin/env bash
# Issue #234 reproduction: hold the host-wide Docker snapshot lock
# (/tmp/start-command-docker-snapshot.lock, or $START_SNAPSHOT_LOCK) with a
# live process, exactly like a parallel test thread or a real `start --resume`
# on the same host would, then run a command (by default the Rust
# regression_193 tests). Before the fix those tests fail with
# `assertion failed: hooks.0.get()` because their resume cannot take the
# shared lock within its 1s budget; after the fix they use a private lock.
set -euo pipefail
lock="${START_SNAPSHOT_LOCK:-/tmp/start-command-docker-snapshot.lock}"
sleep 600 &
holder=$!
trap 'kill "$holder" 2>/dev/null; rm -f "$lock"' EXIT
start=$(sed 's/.*) //' "/proc/$holder/stat" | awk '{print $20}')
printf '{"holder":"another-box","pid":%d,"timestamp":%d,"hostname":"%s","token":"held-by-experiment","processStart":"%s"}' \
  "$holder" "$(date +%s%3N)" "$(hostname)" "$start" > "$lock"
echo "Holding $lock as PID $holder"
cd "$(dirname "$0")/../../rust"
if [ "$#" -eq 0 ]; then set -- cargo test --test regression_193; fi
"$@"
