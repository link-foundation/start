#!/usr/bin/env bash
# Keep real integration tests independent of Docker Hub's shared-runner quotas.
set -euo pipefail

for tag in latest 3.20 3.23; do
  if docker image inspect "alpine:$tag" >/dev/null 2>&1; then
    continue
  fi
  prepared=false
  for attempt in 1 2 3; do
    for repository in mirror.gcr.io/library/alpine public.ecr.aws/docker/library/alpine docker.io/library/alpine; do
      image="$repository:$tag"
      if docker pull "$image"; then
        docker tag "$image" "alpine:$tag"
        prepared=true
        break
      fi
    done
    if "$prepared"; then
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      sleep "$((attempt * 5))"
    fi
  done
  if ! "$prepared"; then
    echo "Unable to prepare alpine:$tag after all registry retries" >&2
    exit 1
  fi
done
