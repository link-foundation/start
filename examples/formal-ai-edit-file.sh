#!/usr/bin/env bash
# Issues #257 and #258: reproducible demo of the structured file tools and the
# capability-gap outcome of the experimental `--use-formal-ai` mode.
#
#   git clone https://github.com/link-assistant/formal-ai.git /tmp/formal-ai
#   START_FORMAL_AI_ROOT=/tmp/formal-ai examples/formal-ai-edit-file.sh
#
# It runs four requests against an isolated copy of the #258 fixture, a file
# with comments, a tab, trailing spaces and a look-alike line in a comment:
#
#   1. a literal edit in workspace-write mode: read, edit and readback; only
#      the declaration line may change (exit 0);
#   2. the same edit in read-only mode: a capability gap (exit 65), no change;
#   3. "show contents of snippet.mjs": the read tool (exit 0), no change;
#   4. a plain question (exit 0).
#
# Set START=/path/to/start to run another build (default: the JS edition of
# this checkout, or `$` from PATH when bun is missing). Nothing is uploaded:
# logs go to a temporary START_LOG_DIR.
set -euo pipefail

if [ -z "${START_FORMAL_AI_ROOT:-}" ] && [ -z "${START_FORMAL_AI_URL:-}" ]; then
  echo "Set START_FORMAL_AI_ROOT to a link-assistant/formal-ai checkout (see docs/formal-ai.md)." >&2
  exit 2
fi
repo="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${START:-}" ]; then
  read -r -a start <<<"$START"
elif command -v bun >/dev/null; then
  start=(bun "$repo/js/src/bin/cli.js")
else
  start=('$')
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/start-formal-ai-edit.XXXXXX")"
trap 'rm -rf "$work"' EXIT
fixture="$work/fixture"
mkdir -p "$fixture"
printf '%s\n' \
  '// Synthetic snippet for issue #258: keep this comment.' \
  'const label = "before";' \
  '' \
  $'\texport function show(name) {  ' \
  '  return `${label}: ${name}`; // trailing comment' \
  '}' \
  '/* label = "before" in a comment stays */' >"$fixture/snippet.mjs"
expected="$work/expected.mjs"
sed '2s/"before"/"after"/' "$fixture/snippet.mjs" >"$expected"
original="$work/original.mjs"
cp "$fixture/snippet.mjs" "$original"

failures=0
# ask EXPECTED_STATUS EFFECTS REQUEST
ask() {
  local expected_status="$1" effects="$2" request="$3" status=0
  echo "### [$effects] \$ --use-formal-ai -- $request"
  (cd "$fixture" && START_LOG_DIR="$work/logs" START_APP_FOLDER="$work/app" \
    START_DISABLE_AUTO_ISSUE=1 START_DISABLE_LOG_UPLOAD=1 \
    START_FORMAL_AI_EFFECTS="$effects" \
    "${start[@]}" --use-formal-ai -- "$request") \
    >"$work/stdout" 2>"$work/stderr" || status=$?
  sed 's/^/stdout: /' "$work/stdout"
  grep -v '^\[formal-ai\] runtime:' "$work/stderr" | sed 's/^/stderr: /' || true
  echo "### exit status: $status (expected $expected_status)"
  if [ "$status" != "$expected_status" ]; then
    failures=$((failures + 1))
  fi
}

same() {
  if cmp -s "$1" "$fixture/snippet.mjs"; then
    echo "### snippet.mjs is $2"
  else
    echo "### snippet.mjs is NOT $2" >&2
    diff "$1" "$fixture/snippet.mjs" >&2 || true
    failures=$((failures + 1))
  fi
}

literal='In snippet.mjs, replace «const label = "before";» with «const label = "after";». Preserve all other content.'
ask 65 read-only "$literal"
same "$original" "unchanged"
ask 0 read-only 'show contents of snippet.mjs'
same "$original" "unchanged"
ask 0 read-only 'What is 2 + 2?'
ask 0 workspace-write "$literal"
same "$expected" "edited on the declaration line only"

echo "### outcomes recorded in the evidence"
find "$work/logs" -name '*.log' -print0 | while IFS= read -r -d '' log; do
  sed -n '/^=== Formal AI Evidence ===$/,/^}$/p' "$log" | sed 1d |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s);console.log(JSON.stringify({request:e.request,outcome:e.outcome}))})' ||
    echo "(no evidence in $log)"
done
exit "$((failures > 0))"
