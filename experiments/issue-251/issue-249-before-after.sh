#!/usr/bin/env bash
# Runs the issue #249 reproduction through the old sanitizer (704a644) and the
# current adapter. Usage: experiments/issue-251/issue-249-before-after.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
printf '%s\n' \
  "gate='/tmp/hive-mind-disk-baseline-0ce9e170-e6d3-494d-91e1-0d820245d34b'" \
  '🧠 Formal AI: endpoint http://172.18.0.2:8080/api/openai/v1' \
  '{"bodyPreview":"{\"messages\":[{\"content\":\"use: curl -L -H \\\"Authorization: token $(gh auth token)\\\" -o <filename> <url>\\n...the rest of a 100 KB prompt...\"}]}"}' \
  'curl -H "Authorization: token ghx1234567890abcdefXYZ" -o out.txt https://api.github.com' \
  "token ghp_$(printf 'x%.0s' $(seq 36)) end" > "$WORK/sample.log"
mkdir -p "$WORK/old"
git -C "$ROOT" show 704a644:js/src/lib/log-sanitizer.js > "$WORK/old/log-sanitizer.js"
show() {
  node -e 'const {sanitizeLogToTemp}=require(process.argv[1]); const r=sanitizeLogToTemp(process.argv[2],{env:{PATH:process.env.PATH,GH_CONFIG_DIR:process.argv[3]}}); process.stdout.write(require("fs").readFileSync(r.path)); r.cleanup()' "$1" "$WORK/sample.log" "$WORK"
}
# The fake token is abbreviated so the saved output does not look like a credential.
echo '== input'; sed 's/ghp_x\{36\}/ghp_<36 x>/' "$WORK/sample.log"
echo '== before (704a644, own sanitizer)'; show "$WORK/old/log-sanitizer.js"
echo '== after (sensitive-data-sanitizer)'; show "$ROOT/js/src/lib/log-sanitizer.js"
