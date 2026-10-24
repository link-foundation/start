#!/usr/bin/env bash
# Issue #253: reproduce what sensitive-data-sanitizer 0.12.1 still gets wrong
# for start-command logs. Each case prints the input and the output.
# Usage: experiments/issue-253/sanitizer-findings.sh [sanitizer-cli.js]
set -u
CLI="${1:-js/node_modules/@link-foundation/sensitive-data-sanitizer/bin/sensitive-data-sanitizer.js}"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
node "$CLI" --version
redact() { node "$CLI" redact - --credentials-only --allow-binary; }

echo "## Closing brackets after an Authorization token stay behind"
for line in 'Authorization: Bearer [REDACTED] already' \
  'Authorization: Bearer {{token}} x' \
  'Authorization: Bearer <token> x' \
  'Authorization: Bearer $GITHUB_TOKEN x'; do
  printf '%s\n  -> %s\n' "$line" "$(printf '%s\n' "$line" | redact)"
done

echo "## A NUL byte right after an Authorization token is removed"
printf 'Authorization: Bearer abc\0 tail\n' | redact | od -c | head -n 3

echo "## Dense tokens: time grows with the square of the input"
node -e '
const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
for (const kib of [32, 64, 128]) {
  let s = "";
  while (s.length < kib * 1024) {
    let t = "ghp_";
    for (let i = 0; i < 36; i++) t += c[(Math.random() * 62) | 0];
    s += t + "\n";
  }
  require("fs").writeFileSync(process.argv[1] + "/dense-" + kib + ".log", s);
}' "$DIR"
for kib in 32 64 128; do
  start=$(date +%s%N)
  redact < "$DIR/dense-$kib.log" > /dev/null
  echo "$kib KiB of ghp_ tokens: $((($(date +%s%N) - start) / 1000000)) ms"
done
