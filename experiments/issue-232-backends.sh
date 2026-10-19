#!/bin/sh
# Runs the reproductions of #229 (screen), #230 (docker) and #231 (alias
# resolution) from the issues against one implementation.
# Usage: experiments/issue-232-backends.sh [js|rust]
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
case "${1:-js}" in
  rust) start() { "$root/.cargo-target/debug/start" "$@"; } ;;
  *) start() { bun "$root/js/src/bin/cli.js" "$@"; } ;;
esac
sandbox=$(mktemp -d)
export START_APP_FOLDER="$sandbox/app" START_LOG_DIR="$sandbox/logs"
export START_DISABLE_AUTO_ISSUE=1 START_DISABLE_LOG_UPLOAD=1
unset START_EXECUTION_ID START_ATTEMPT START_SESSION_NAME
# A stub uploader, so --upload-log never publishes anything.
mkdir -p "$sandbox/bin"
cat > "$sandbox/bin/gh-upload-log" <<'STUB'
#!/bin/sh
for a; do [ -f "$a" ] && echo "stub upload of $a: $(grep -c '"event":"continuation"' "$a") continuation headers"; done
STUB
chmod +x "$sandbox/bin/gh-upload-log"
export PATH="$sandbox/bin:$PATH"
U=$(cat /proc/sys/kernel/random/uuid)
LOG=$START_LOG_DIR/isolation/screen/$U.log

echo "## #229 screen reproduction"
start --isolated screen --detached --session "$U" --session-id "$U" -- sh -c 'echo first-run-output' >/dev/null
sleep 3; echo "after launch: $(grep -c first-run-output "$LOG")"
start --resume "$U" >/dev/null
sleep 3; echo "after resume: $(grep -c first-run-output "$LOG")"
start --isolated screen --detached --session "other-$U" --session-id "$U" -- sh -c 'echo second-launch-output'
echo "relaunch exit=$?"
sleep 1; echo "after relaunch: $(grep -c first-run-output "$LOG")"
start --isolated screen --detached --session "other-$U" --session-id "$U" --append-attempt -- sh -c 'echo second-launch-output $START_ATTEMPT $START_SESSION_NAME' >/dev/null
sleep 3; echo "after append: $(grep -c first-run-output "$LOG") $(grep -c "second-launch-output 3 other-$U" "$LOG")"
start --status "$U" --output-format json | grep -E '"(number|mode|sessionName)"' | head -8

echo "## #230 docker"
V=$(cat /proc/sys/kernel/random/uuid)
start -i docker --image alpine:latest --session "box-$V" --session-id "$V" -e START_EXECUTION_ID=spoofed -- env 2>&1 | grep -E '^START_(EXECUTION_ID|SESSION_NAME|ATTEMPT)='

echo "## #231 alias resolution"
A=$(cat /proc/sys/kernel/random/uuid)
start --alias "$U" "$A"
start --status "$A" --output-format json | grep -A3 '"aliases"' | head -4
start --stop "$A" 2>&1 | head -2
B=$(cat /proc/sys/kernel/random/uuid)
start --session-id "$B" --continues "$A" -- echo continued >/dev/null
start --upload-log "$B" 2>&1 | grep stub
start --screen-cleanup >/dev/null 2>&1
screen -ls | grep -E "$U" | awk '{print $1}' | xargs -r -I{} screen -S {} -X quit
docker rm -f "box-$V" >/dev/null 2>&1
rm -rf "$sandbox"
