#!/usr/bin/env bash
#
# A detached Docker execution that is SIGKILLed from outside the container.
#
# Shows what issues #170 and #171 are about: once the container is gone, the
# execution record must be terminal (not `executing` forever), its `endTime`
# must come from a real clock and say so, and the log must carry the facts
# `docker inspect` still had while the container existed.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed; skipping the post-mortem example."
  exit 0
fi

START_BIN="${START_BIN:-$}"
IMAGE="${IMAGE:-alpine:latest}"

output=$("${START_BIN}" --isolated docker --image "${IMAGE}" --detached -- \
  sh -c 'echo long running; sleep 300')
echo "${output}"

uuid=$(echo "${output}" | grep -m1 '│ session' | awk '{print $3}')
container=$(echo "${output}" | grep -m1 '│ container' | awk '{print $3}')

sleep 2
docker kill --signal=KILL "${container}" >/dev/null

# Wait for the completion watcher to observe the ending and finalize the record.
until [ "$(docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null)" != true ]; do
  sleep 1
done
until "${START_BIN}" --status "${uuid}" --output-format text | grep -q 'Status: *executed'; do
  sleep 1
done

echo
echo "=== The log ends with the post-mortem, before the footer ==="
"${START_BIN}" --status "${uuid}" --output-format text |
  awk '/Log Path:/ {print $3}' |
  xargs -r tail -n 25

echo
echo "=== The record is terminal, and says where its endTime came from ==="
"${START_BIN}" --status "${uuid}" --output-format text |
  grep -E 'Status:|Exit Code|OOM Killed|Exit Reason|End Time'

# Expected:
#   Exit Code:       137 (SIGKILL - 128+9)
#   OOM Killed:      false        <- an external kill, not the cgroup OOM killer
#   Exit Reason:     signal (SIGKILL)
#   End Time Source: docker-finished-at

docker rm -f "${container}" >/dev/null 2>&1 || true
