#!/usr/bin/env bash
# Replay check-rust-coverage.mjs on the Code Coverage (Rust) output of a
# downloaded `gh run view --log` file (issue #234).
# Usage: experiments/issue-234/replay-rust-coverage.sh <run.log>
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
grep -F 'Code Coverage (Rust, Linux only)' "$1" \
  | cut -f3- \
  | sed -E 's/^[0-9T:.-]+Z //' > "$tmp"
node "$root/scripts/check-rust-coverage.mjs" "$tmp" --threshold 50
