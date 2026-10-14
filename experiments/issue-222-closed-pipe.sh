#!/usr/bin/env bash
# Issue #222: a closed stdout pipe must not crash start or replace exit codes.
# Usage: experiments/issue-222-closed-pipe.sh [start-binary...]
# Defaults to the Rust debug build and the JavaScript CLI.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
export START_APP_FOLDER=$(mktemp -d) START_DISABLE_AUTO_ISSUE=1 START_DISABLE_LOG_UPLOAD=1
[ $# -gt 0 ] || set -- "$root/.cargo-target/debug/start" "bun $root/js/src/bin/cli.js"
for start in "$@"; do
  echo "== $start"
  $start --version | head -1 >/dev/null; echo "--version | head -1: exit=${PIPESTATUS[0]} (want 0)"
  $start --version | true; echo "--version | true: exit=${PIPESTATUS[0]} (want 0)"
  timeout 60 $start -- sh -c 'seq 1 200000; exit 3' 2>/dev/null | head -1 >/dev/null
  echo "run | head -1: exit=${PIPESTATUS[0]} (want 3)"
  timeout 60 $start -- sh -c 'seq 1 200000; seq 1 200000 >&2; exit 3' 2>&1 | true
  echo "run 2>&1 | true: exit=${PIPESTATUS[0]} (want 3)"
done
