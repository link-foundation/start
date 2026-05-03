#!/usr/bin/env bash
# check-mjs-syntax.sh
#
# Fast pre-flight: run `node --check` on every .mjs file in `scripts/`,
# `js/src/`, `js/test/`, `js/scripts/`, and the repo root. Catches the
# common "broken merge resolved with a syntax error" failure before the
# slow lint / test matrix has to spin up.
#
# Ported from
# https://github.com/link-foundation/js-ai-driven-development-pipeline-template
# (see docs/case-studies/issue-118/comparison-with-templates.md).
#
# Usage:
#   bash scripts/check-mjs-syntax.sh
#
# Exit code 0 = all files pass syntax check; non-zero = syntax error.

set -euo pipefail

echo "Checking syntax for all .mjs files..."

CHECKED=0
DIRS=(
  "scripts"
  "js/scripts"
  "js/src"
  "js/test"
)

for dir in "${DIRS[@]}"; do
  if [ -d "$dir" ]; then
    while IFS= read -r -d '' file; do
      echo "Checking $file..."
      timeout 10s node --check "$file"
      CHECKED=$((CHECKED + 1))
    done < <(find "$dir" -name "*.mjs" -type f -print0)
  fi
done

echo ""
echo "Syntax check passed for $CHECKED file(s)."
