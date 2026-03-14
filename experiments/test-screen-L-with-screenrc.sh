#!/bin/bash
# Test: screen -L -dmS with screenrc logfile (the fix for issue #96)
#
# Key insight: `deflog on` in screenrc only applies to windows created AFTER
# the screenrc is processed. But the default window is created BEFORE screenrc
# processing. The -L flag is needed to enable logging for the initial window.
#
# This script tests that -L + screenrc logfile path works together to capture
# output, which is the fix for issue #96 on macOS screen 4.00.03.

set -e

echo "=== Test: screen -L -dmS with screenrc logfile ==="
echo ""
echo "Screen version:"
screen --version 2>&1 || true
echo ""

SESSION="test-L-rc-$$"
LOGFILE="/tmp/screen-output-${SESSION}.log"
SCREENRC="/tmp/screenrc-${SESSION}"
EXIT_CODE_FILE="/tmp/screen-exit-${SESSION}.code"

# Create screenrc with logfile path and flush settings
cat > "$SCREENRC" << EOF
logfile $LOGFILE
logfile flush 0
deflog on
EOF

echo "screenrc content:"
cat "$SCREENRC"
echo ""

# Remove any stale log file
rm -f "$LOGFILE"

COMMAND='echo "hello-from-screen-L"'
WRAPPED_COMMAND="${COMMAND}; echo \$? > \"${EXIT_CODE_FILE}\""

echo "Running: screen -dmS $SESSION -L -c $SCREENRC /bin/sh -c '${WRAPPED_COMMAND}'"
screen -dmS "$SESSION" -L -c "$SCREENRC" /bin/sh -c "$WRAPPED_COMMAND"

# Wait for session to end
waited=0
while [ $waited -lt 5000 ]; do
    sleep 0.1
    waited=$((waited + 100))
    if ! screen -ls 2>/dev/null | grep -q "$SESSION"; then
        echo "Session ended after ${waited}ms"
        break
    fi
done

# Check log file
echo ""
if [ -f "$LOGFILE" ]; then
    echo "✓ Log file EXISTS: $LOGFILE"
    echo "  Content: $(cat "$LOGFILE")"
    echo "  Size: $(wc -c < "$LOGFILE") bytes"
else
    echo "✗ Log file NOT FOUND: $LOGFILE"
    # Check for default screenlog.0
    if [ -f "screenlog.0" ]; then
        echo "  BUT screenlog.0 exists (logfile directive ignored)!"
        echo "  Content: $(cat screenlog.0)"
        rm -f screenlog.0
    fi
fi

# Check exit code file
echo ""
if [ -f "$EXIT_CODE_FILE" ]; then
    echo "✓ Exit code file: $(cat "$EXIT_CODE_FILE")"
else
    echo "✗ Exit code file NOT FOUND"
fi

# Cleanup
rm -f "$LOGFILE" "$SCREENRC" "$EXIT_CODE_FILE"

echo ""
echo "=== Test 2: Quick command (simulating 'agent --version') ==="
echo ""

SESSION2="test-L-rc2-$$"
LOGFILE2="/tmp/screen-output-${SESSION2}.log"
SCREENRC2="/tmp/screenrc-${SESSION2}"
EXIT_CODE2="/tmp/screen-exit-${SESSION2}.code"

cat > "$SCREENRC2" << EOF
logfile $LOGFILE2
logfile flush 0
deflog on
EOF

rm -f "$LOGFILE2"

# Simulate a quick-completing version command
echo "Running: screen -dmS $SESSION2 -L -c $SCREENRC2 /bin/sh -c 'echo v1.2.3; echo \$? > exit_file'"
screen -dmS "$SESSION2" -L -c "$SCREENRC2" /bin/sh -c "echo v1.2.3; echo \$? > \"${EXIT_CODE2}\""

waited=0
while [ $waited -lt 5000 ]; do
    sleep 0.1
    waited=$((waited + 100))
    if ! screen -ls 2>/dev/null | grep -q "$SESSION2"; then
        echo "Session ended after ${waited}ms"
        break
    fi
done

echo ""
if [ -f "$LOGFILE2" ]; then
    CONTENT=$(cat "$LOGFILE2")
    echo "✓ Log file EXISTS"
    echo "  Content: \"$CONTENT\""
    if echo "$CONTENT" | grep -q "v1.2.3"; then
        echo "  ✓ Output captured correctly!"
    else
        echo "  ✗ Output NOT captured (empty or wrong)"
    fi
else
    echo "✗ Log file NOT FOUND"
fi

rm -f "$LOGFILE2" "$SCREENRC2" "$EXIT_CODE2"

echo ""
echo "=== Done ==="
