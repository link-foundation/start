#!/usr/bin/env bash
# Issue #261: the exact synthetic reproduction against a real Formal AI runtime.
#
#   START_FORMAL_AI_ROOT=/path/to/formal-ai experiments/issue-261/repro.sh [request]
#
# draft.txt holds `draft\n`, verified-source.txt holds `verified\n` and must
# stay unchanged. The request asks for a literal replacement in draft.txt.
# Prints the exit status, both files' bytes and the evidence outcome.
set -uo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
request="${1:-In draft.txt, replace «draft» with «verified».}"
work="$(mktemp -d "${TMPDIR:-/tmp}/start-261.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/ws"
printf 'draft\n' >"$work/ws/draft.txt"
printf 'verified\n' >"$work/ws/verified-source.txt"
status=0
(cd "$work/ws" && START_LOG_DIR="$work/logs" START_APP_FOLDER="$work/app" \
  START_DISABLE_AUTO_ISSUE=1 START_DISABLE_LOG_UPLOAD=1 \
  START_FORMAL_AI_EFFECTS="${START_FORMAL_AI_EFFECTS:-workspace-write}" \
  bun "$repo/js/src/bin/cli.js" --use-formal-ai -- "$request") || status=$?
echo "### exit status: $status"
for f in draft.txt verified-source.txt; do
  echo "### $f: $(od -An -c "$work/ws/$f" | tr -s ' ')"
done
find "$work/logs" -name '*.log' -print0 | while IFS= read -r -d '' log; do
  sed -n '/^=== Formal AI Evidence ===$/,/^}$/p' "$log" | sed 1d |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);for(const st of e.steps)console.log(JSON.stringify(st).slice(0,600));console.log(JSON.stringify(e.outcome,null,1))})'
done
