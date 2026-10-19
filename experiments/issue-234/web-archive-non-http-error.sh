#!/usr/bin/env bash
# Reproduce: a lychee report whose only error is a missing local file makes
# scripts/check-web-archive.mjs report all_archived=true and exit 0, so the
# links workflow's "Fail if broken links found" step is skipped and the run
# is green (template issue #138). No network access is needed.
set -u
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/out.md" <<'REPORT'
## Errors per input

### Errors in README.md

* [ERROR] <file:///repo/docs/missing.md> | Cannot find file
REPORT
: > "$work/github-output"
LYCHEE_OUTPUT="$work/out.md" GITHUB_OUTPUT="$work/github-output" \
  node "$(dirname "$0")/../../scripts/check-web-archive.mjs"
echo "exit code: $?"
echo "GITHUB_OUTPUT: $(cat "$work/github-output")"
