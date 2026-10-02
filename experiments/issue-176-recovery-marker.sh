#!/bin/sh
# Issue #176: can a stopped container run a *different* command on `docker start`,
# in the same container (same filesystem, same HostConfig limits)?
# Approach: launch through a tiny selector; recovery drops a marker via `docker cp`.
set -u
name=issue-176-recovery-$$
docker rm -f "$name" >/dev/null 2>&1 || true
selector='r=$1; shift; if [ -e /.start-command-recovery ]; then START_COMMAND_RECOVERY_ATTEMPT=$(cat /.start-command-recovery 2>/dev/null); export START_COMMAND_RECOVERY_ATTEMPT; exec sh -c "$r"; fi; exec "$@"'
# Main command: write state, then block until it is SIGKILLed (as the OOM killer would).
docker run -d --name "$name" --user 1000:1000 alpine:3.20 \
  sh -c "$selector" start-command 'echo "recovery attempt=$START_COMMAND_RECOVERY_ATTEMPT state=$(cat /tmp/state)"' \
  sh -c 'echo main > /tmp/state; echo main running; sleep 30' >/dev/null
sleep 1; docker kill -s KILL "$name" >/dev/null  # stands in for the OOM killer (exit 137)
docker wait "$name" >/dev/null
echo "after main: $(docker inspect -f 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} mem={{.HostConfig.Memory}}' "$name")"
docker logs "$name" 2>&1 | tail -2
tmp=$(mktemp); echo 1 > "$tmp"; chmod 644 "$tmp"
docker cp "$tmp" "$name:/.start-command-recovery" && echo "docker cp into stopped container: ok"
rm -f "$tmp"
docker start "$name" >/dev/null; docker wait "$name" >/dev/null
echo "after recovery: $(docker inspect -f 'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} mem={{.HostConfig.Memory}}' "$name")"
docker logs "$name" 2>&1 | tail -1
docker rm -f "$name" >/dev/null
