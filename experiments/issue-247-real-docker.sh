#!/bin/sh
# Real-daemon reproduction of issue #247: on a host whose containers have no
# memory.events (the memory controller is not delegated), count the docker
# processes the detached cgroup sampler starts while the task runs.
# A logging `docker` shim goes first on PATH; the CLI under test runs one
# detached docker task. Bounded: the task sleeps SECONDS (default 20) and the
# container is removed afterwards.
# Usage: [CLI=js/src/bin/cli.js] [SECONDS=20] [INTERVAL=1] sh experiments/issue-247-real-docker.sh
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
cli="${CLI:-$root/js/src/bin/cli.js}"
seconds="${SECONDS_TO_RUN:-${SECONDS:-20}}"
work=$(mktemp -d)
real_docker=$(command -v docker)
name="start-247-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir "$work/bin"
cat > "$work/bin/docker" <<SHIM
#!/bin/sh
printf '%s %s\n' "\$(date +%s)" "\$*" | cut -c 1-120 >> "$work/calls"
exec "$real_docker" "\$@"
SHIM
chmod +x "$work/bin/docker"
echo "memory.events inside a container:"
"$real_docker" run --rm "${IMAGE:-alpine:3.20}" sh -c 'cat /sys/fs/cgroup/memory.events 2>&1 || true'
export PATH="$work/bin:$PATH"
export START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS="${INTERVAL:-1}" START_LOG_DIR="$work/logs"
: > "$work/calls"
node "$cli" --isolated docker --detached --session "$name" --image "${IMAGE:-alpine:3.20}" -- sleep "$seconds" > "$work/out" 2>&1 || cat "$work/out"
# Wait for the container to finish, then for the watcher to finish its work.
i=0
while [ "$i" -lt $((seconds + 30)) ] && [ "$("$real_docker" inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; do sleep 1; i=$((i+1)); done
sleep 3
echo "docker calls while the task ran (${seconds} s, interval ${START_COMMAND_CGROUP_SAMPLE_INTERVAL_SECONDS} s):"
for pattern in 'exec -i' 'exec ' '{{.State.Running}}' '{{.HostConfig.CgroupnsMode}}'; do
  printf '  %-30s %s\n' "$pattern" "$(cut -d ' ' -f 2- "$work/calls" | grep -cF -- "$pattern" || true)"
done
echo "  total                          $(wc -l < "$work/calls")"
echo "Memory line of the post-mortem:"
find "$work/logs" -name '*.log' -exec grep -h '^Memory:' {} + || true
