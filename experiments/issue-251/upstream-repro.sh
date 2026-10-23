#!/usr/bin/env bash
# Reproduces the sensitive-data-sanitizer 0.12.0 behaviors start-command works
# around (issue #250). Usage: experiments/issue-251/upstream-repro.sh [cli]
set -u
CLI=${1:-js/node_modules/.bin/sensitive-data-sanitizer}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export GH_CONFIG_DIR="$WORK/gh"
mkdir -p "$GH_CONFIG_DIR"
run() { env -i PATH="$PATH" HOME="$WORK" GH_CONFIG_DIR="$GH_CONFIG_DIR" "$@"; }

"$CLI" --version

echo '== 1. Authorization value: unquoted and single-quoted run to the end of the line'
printf '%s\n' \
  'curl -H "Authorization: token ghx1234567890abcdefXYZ" keep-after' \
  "curl -H 'Authorization: token ghx1234567890abcdefXYZ' keep-after" \
  'Authorization: Bearer abc.def.ghi keep-after' \
  '{"p":"use \"Authorization: token abc123def456\" keep-after"}' |
  run "$CLI" redact - --credentials-only

echo '== 2. NUL byte in a log'
printf 'line one\n\0line two\n' | run "$CLI" redact - --credentials-only --stream \
  --output "$WORK/nul.out"
echo "exit=$?"

echo '== 3. env secret whose value is a host name'
printf 'git remote: https://github.com/owner/repo\n' |
  run env GIT_AUTH_TRANSPORT=github.com "$CLI" redact - --credentials-only --env-secrets

echo '== 4. file mode on a large log (worker deadline) vs stdin mode'
node experiments/issue-251/make-large-log.js "$WORK/large.log" "${LARGE_MIB:-80}"
ls -l "$WORK/large.log"
start=$(date +%s)
run "$CLI" redact "$WORK/large.log" --stream --credentials-only --output "$WORK/file.out"
echo "file mode exit=$? seconds=$(( $(date +%s) - start ))"
start=$(date +%s)
run "$CLI" redact - --stream --credentials-only --max-bytes 1000000000 \
  --output "$WORK/stdin.out" < "$WORK/large.log"
echo "stdin mode exit=$? seconds=$(( $(date +%s) - start ))"
