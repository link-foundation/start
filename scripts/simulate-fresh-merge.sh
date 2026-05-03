#!/usr/bin/env bash
# simulate-fresh-merge.sh
#
# Validate the *actual* tree that will exist on `main` after this PR is
# merged, not the contents of the PR branch in isolation. CI normally
# checks out the PR head; for a 3-way merge to fail in production we
# would have to reproduce the merge first. This script does that
# locally so syntax/lint failures from broken conflict resolutions are
# caught before merge instead of after.
#
# Strategy:
#   1. Fetch the merge base (from `--base-ref`, default `origin/main`).
#   2. Create a throw-away worktree under .git/.simulate-merge-XXXX.
#   3. Merge the PR head into that worktree without committing.
#   4. Run a verification command (default: `bash scripts/check-mjs-syntax.sh`).
#   5. Always clean up the worktree, even on failure.
#
# Inspired by the JS pipeline template
# (https://github.com/link-foundation/js-ai-driven-development-pipeline-template).
# See docs/case-studies/issue-118/comparison-with-templates.md.
#
# Usage:
#   bash scripts/simulate-fresh-merge.sh
#   bash scripts/simulate-fresh-merge.sh --base-ref origin/main \
#       --check 'bash scripts/check-mjs-syntax.sh'
#
# Exit code 0 = merge clean and check passes; non-zero = merge conflict
# or check failure.

set -euo pipefail

BASE_REF="origin/main"
CHECK_CMD="bash scripts/check-mjs-syntax.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --base-ref)
      BASE_REF="$2"
      shift 2
      ;;
    --check)
      CHECK_CMD="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "::error::simulate-fresh-merge.sh must be run inside a git checkout" >&2
  exit 1
fi

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "::error::Base ref '$BASE_REF' not found. Did you fetch with --depth 0?" >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
WORKTREE_DIR="$(mktemp -d -t simulate-merge.XXXXXX)"
trap 'git worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true; rm -rf "$WORKTREE_DIR"' EXIT

echo "Base: $BASE_REF ($(git rev-parse --short "$BASE_REF"))"
echo "Head: $HEAD_SHA ($(git rev-parse --short HEAD))"
echo "Simulating merge in: $WORKTREE_DIR"
echo "Check command: $CHECK_CMD"
echo ""

git worktree add --detach "$WORKTREE_DIR" "$BASE_REF" >/dev/null

(
  cd "$WORKTREE_DIR"
  if ! git merge --no-commit --no-ff "$HEAD_SHA"; then
    echo "::error::Merge of $HEAD_SHA into $BASE_REF produced conflicts." >&2
    git status --short || true
    exit 1
  fi

  echo ""
  echo "Merged tree built. Running check…"
  echo ""
  bash -c "$CHECK_CMD"
)

echo ""
echo "✅ simulate-fresh-merge: clean merge, check passed."
