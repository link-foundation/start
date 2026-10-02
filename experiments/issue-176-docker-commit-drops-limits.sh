#!/bin/sh
# Issue #176: `docker commit` + `docker run` (the DOCKER_SNAPSHOT resume path)
# does not carry the original container's HostConfig resource limits.
set -eu
name=issue-176-limits-$$
docker rm -f "$name" "$name-resume-1" >/dev/null 2>&1 || true
docker create --name "$name" alpine:3.20 sh -c 'sleep 1' >/dev/null
docker update --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 64 "$name" >/dev/null
fmt='Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} NanoCpus={{.HostConfig.NanoCpus}} PidsLimit={{.HostConfig.PidsLimit}}'
echo "original: $(docker inspect -f "$fmt" "$name")"
docker commit "$name" "start-command-resume/$name:1" >/dev/null
docker create --name "$name-resume-1" "start-command-resume/$name:1" sh -c 'true' >/dev/null
echo "resumed:  $(docker inspect -f "$fmt" "$name-resume-1")"
echo "hostconfig json (limits subset):"
docker inspect -f '{{json .HostConfig}}' "$name" | head -c 2000; echo
docker rm -f "$name" "$name-resume-1" >/dev/null
docker rmi "start-command-resume/$name:1" >/dev/null
