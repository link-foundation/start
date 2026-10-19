#!/usr/bin/env bash
# Run publish-to-npm.mjs against a fake npm whose publish always fails and
# print the GitHub Actions outputs it wrote (issue #234).
# Usage: experiments/issue-234/replay-failed-npm-publish.sh [script]
#   script defaults to scripts/publish-to-npm.mjs; pass a copy of an older
#   revision (kept inside scripts/ so its relative imports resolve).
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="${1:-$root/scripts/publish-to-npm.mjs}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/pkg"
cp "$root/js/test/fixtures/fake-npm.sh" "$work/bin/npm"
echo fail > "$work/mode"
echo '{"name":"start-command","version":"9.9.9"}' > "$work/pkg/package.json"
: > "$work/github-output"
REAL_NPM="$(command -v npm)" PATH="$work/bin:$PATH" FAKE_NPM_STATE="$work" FAKE_NPM_VERSION=9.9.9 \
  GITHUB_OUTPUT="$work/github-output" \
  node "$script" --working-dir "$work/pkg"
echo "exit code: $?"
echo "publish attempts: $(grep -c '^run changeset:publish' "$work/calls")"
echo "GITHUB_OUTPUT:"
cat "$work/github-output"
