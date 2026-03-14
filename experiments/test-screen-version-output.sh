#!/bin/bash
# Test if screen properly captures output from quick commands
# This tests the race condition in issue #96

SESSION="test-screen-issue-96-$$"
LOGFILE="/tmp/screen-test-issue96-${SESSION}.log"

echo "=== Test 1: Basic echo (modern screen with -L -Logfile) ==="
screen -dmS "$SESSION" -L -Logfile "$LOGFILE" bash -c "echo hello-from-screen"
sleep 0.5
echo "Log content after 0.5s:"
cat "$LOGFILE" 2>/dev/null || echo "(log file not found)"
# Clean up
screen -S "$SESSION" -X quit 2>/dev/null || true
rm -f "$LOGFILE"

echo ""
echo "=== Test 2: Version-like command (quick exit) ==="
SESSION2="test-screen-issue96-v2-$$"
LOGFILE2="/tmp/screen-test-issue96-v2-${SESSION2}.log"
screen -dmS "$SESSION2" -L -Logfile "$LOGFILE2" bash -c "echo 0.13.2"
sleep 0.5
echo "Log content after 0.5s:"
cat "$LOGFILE2" 2>/dev/null || echo "(log file not found)"
screen -S "$SESSION2" -X quit 2>/dev/null || true
rm -f "$LOGFILE2"

echo ""
echo "=== Test 3: Tee fallback (older screen method) ==="
SESSION3="test-screen-issue96-v3-$$"
LOGFILE3="/tmp/screen-test-issue96-v3-${SESSION3}.log"
screen -dmS "$SESSION3" bash -c "(echo 0.13.2) 2>&1 | tee \"$LOGFILE3\""
sleep 0.5
echo "Log content after 0.5s:"
cat "$LOGFILE3" 2>/dev/null || echo "(log file not found)"
screen -S "$SESSION3" -X quit 2>/dev/null || true
rm -f "$LOGFILE3"
