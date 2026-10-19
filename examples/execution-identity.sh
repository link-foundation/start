#!/bin/sh
# Demonstrates issues #229, #230 and #231 against one implementation.
# Usage: experiments/issue-232-identity-demo.sh [js|rust]
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
case "${1:-js}" in
  rust) start() { "$root/.cargo-target/debug/start" "$@"; } ;;
  *) start() { bun "$root/js/src/bin/cli.js" "$@"; } ;;
esac
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
export START_APP_FOLDER="$sandbox/app" START_LOG_DIR="$sandbox/logs"
export START_DISABLE_AUTO_ISSUE=1 START_DISABLE_LOG_UPLOAD=1
unset START_EXECUTION_ID START_ATTEMPT START_SESSION_NAME
A=23200000-0000-4000-8000-00000000000a
B=23200000-0000-4000-8000-00000000000b

echo '## #230: identity variables'
start --session-id "$A" -- sh -c 'echo "ID=$START_EXECUTION_ID S=$START_SESSION_NAME A=$START_ATTEMPT"'
echo '## #229: reusing the id is refused'
start --session-id "$A" -- echo again; echo "exit=$?"
echo '## #229: --append-attempt'
start --session-id "$A" --append-attempt -- sh -c 'echo attempt $START_ATTEMPT'; echo "exit=$?"
echo '## #231: names and chains'
start --alias "$A" task-1; echo "exit=$?"
start --rename "$A" nightly; echo "exit=$?"
start --session-id "$B" --continues nightly -- echo continued; echo "exit=$?"
start --status "$B" --output-format text
start --status "$B"
