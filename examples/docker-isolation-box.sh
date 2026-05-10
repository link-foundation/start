#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed; skipping box isolation examples."
  exit 0
fi

START_BIN="${START_BIN:-$}"

"${START_BIN}" --isolated docker --image ghcr.io/link-foundation/box-js:latest -- bun --version
"${START_BIN}" --isolated docker --image ghcr.io/link-foundation/box:latest -- bash -lc 'node --version && python --version && rustc --version'
