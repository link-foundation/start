#!/usr/bin/env bash
# Issue #255: run paraphrases of the issue's request against a real Formal AI
# checkout (START_FORMAL_AI_ROOT) and print the tool calls and exit statuses.
set -uo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/fx/sub dir"; printf 'x\n' >"$work/fx/a b.txt"; printf 'y\n' >"$work/fx/ünï.md"
requests=(
  "print list of files in current directory"
  "print list of files in corrent directory"
  "list files here"
  "show me the files in this folder"
  "what files are in the current directory"
  "delete all files"
)
for request in "${requests[@]}"; do
  read -r -a words <<<"$request"
  (cd "$work/fx" && START_LOG_DIR="$work/logs" START_APP_FOLDER="$work/app" \
    START_DISABLE_AUTO_ISSUE=1 START_DISABLE_LOG_UPLOAD=1 \
    bun "$repo/js/src/bin/cli.js" --use-formal-ai -- "${words[@]}") >/dev/null 2>"$work/err"
  status=$?
  echo "## $request -> exit $status"
  grep -E '^\[formal-ai\] (\$ |refused|completed|unsupported|answered|remaining|budget|protocol)' "$work/err"
done
