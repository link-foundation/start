#!/usr/bin/env sh
# Issue #165: verify the kept-container footer reason string produced by
# buildDockerKeptReasonSnippet() for a self-abort exit code (139) and for an
# ordinary failure (1).
set -u
snippet=$(node -e "process.stdout.write(require('$(pwd)/js/src/lib/docker-cleanup').buildDockerKeptReasonSnippet())")
for pair in "139 false" "1 false" "137 true"; do
  set -- $pair
  __start_command_exit=$1
  __start_command_oom=$2
  eval "$snippet"
  printf 'exit=%s oom=%s -> Reason: %s\n' "$1" "$2" "$__start_command_reason"
done
