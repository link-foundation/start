#!/bin/sh
# Real-daemon check of the long-lived sampler exec (issue #242). The local
# cgroup is hidden, as with a mounted docker.sock, so the sampler must stream
# from inside a private-namespace container. A cgroup-shaped directory is
# bind-mounted at /sys/fs/cgroup (hosts with a threaded docker cgroup cannot
# apply --memory) and the host bumps oom_kill mid-run. The sampler is stopped
# while the task still runs, to show the stream ends with it. Bounded: the task
# runs 20 s at most and is removed afterwards.
# Usage: [NAME=<container>] sh experiments/issue-242-real-docker.sh [<sampler-start> <sampler-stop>]
# (the snippets default to the JavaScript implementation; a start snippet
# from a file must name the container NAME)
set -eu
name="${NAME:-start-242-$$}"
work=$(mktemp -d)
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir "$work/cg"
printf 'oom 0\noom_kill 0\n' > "$work/cg/memory.events"
echo 67108864 > "$work/cg/memory.max"
echo 1048576 > "$work/cg/memory.peak"
docker run -d --name "$name" --cgroupns private -v "$work/cg:/sys/fs/cgroup:ro" \
  "${IMAGE:-alpine:3.23}" sh -c 'sleep 20' >/dev/null
export TMPDIR="$work" START_COMMAND_CGROUP_ROOT="$work/hidden" START_COMMAND_PROC_ROOT="$work/hidden"
export START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS="${INTERVAL:-1}"
root=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -ge 2 ]; then
  start_snippet=$(cat "$1")
  stop_snippet=$(cat "$2")
else
  start_snippet=$(name="$name" node -e 'process.stdout.write(require(process.argv[1]).buildCgroupSamplerStartSnippet(process.env.name))' "$root/js/src/lib/cgroup-memory.js")
  stop_snippet=$(node -e 'process.stdout.write(require(process.argv[1]).buildCgroupSamplerStopSnippet())' "$root/js/src/lib/cgroup-memory.js")
fi
# Watcher scripts run without -e/-u, like the generated ones.
set +eu
eval "$start_snippet"
sleep 4
printf 'oom 1\noom_kill 1\n' > "$work/cg/memory.events"
sleep 2
echo "processes inside the task container while streaming:"
docker exec "$name" ps -o pid,args | grep -v 'ps -o'
echo "sample after 6 s: $(cat "$__start_command_cgroup_file")"
eval "$stop_snippet"
echo "final sample: $__start_command_cgroup"
sleep 2
echo "processes inside the task container after the sampler stopped:"
docker exec "$name" ps -o pid,args | grep -v 'ps -o'
echo "reason: ${__start_command_memory_unavailable:-none}"
echo "left-over temp files: $(ls "$work" | grep -vc '^cg$')"
