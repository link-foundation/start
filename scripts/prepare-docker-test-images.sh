#!/usr/bin/env bash
# Keep real integration tests independent of Docker Hub's shared-runner quotas.
set -euo pipefail

for tag in latest 3.20 3.23; do
  image="public.ecr.aws/docker/library/alpine:$tag"
  docker pull "$image"
  docker tag "$image" "alpine:$tag"
done
