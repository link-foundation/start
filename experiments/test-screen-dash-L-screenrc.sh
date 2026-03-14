#!/bin/bash
# Test: screen -L with logfile set in screenrc (without -Logfile option)
# This should work on screen 4.00.03 (macOS) since -L is supported, just not -Logfile

set -e

SESSION="test-rc-L-$$"
LOGFILE="/tmp/screen-output-${SESSION}.log"
SCREENRC="/tmp/screenrc-${SESSION}"

echo "=== Test: screen -L with screenrc logfile path ==="
echo ""

# Create screenrc that sets log file path and flush
cat > "$SCREENRC" << EOF
logfile $LOGFILE
logfile flush 0
EOF

echo "screenrc content:"
cat "$SCREENRC"
echo ""

# Run screen with -L flag (enables logging) and -c for screenrc (sets log path)
echo "Running: screen -dmS $SESSION -c $SCREENRC -L /bin/sh -c 'echo hello-L-test'"
screen -dmS "$SESSION" -c "$SCREENRC" -L /bin/sh -c 'echo "hello-L-test"'

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
    echo "Log file EXISTS: $LOGFILE"
    echo "Content: $(cat "$LOGFILE")"
    echo "Size: $(wc -c < "$LOGFILE") bytes"
    rm -f "$LOGFILE"
else
    echo "Log file NOT FOUND: $LOGFILE"
    # Check for default screenlog.0
    if [ -f "screenlog.0" ]; then
        echo "BUT screenlog.0 exists!"
        echo "Content: $(cat screenlog.0)"
        rm -f screenlog.0
    fi
fi

# Cleanup
rm -f "$SCREENRC"

echo ""
echo "=== Test 2: -L without -Logfile, with screenrc logfile ==="
echo ""

SESSION2="test-rc-L2-$$"
LOGFILE2="/tmp/screen-output-${SESSION2}.log"
SCREENRC2="/tmp/screenrc-${SESSION2}"

cat > "$SCREENRC2" << EOF
logfile $LOGFILE2
logfile flush 0
deflog on
EOF

echo "screenrc content:"
cat "$SCREENRC2"
echo ""

echo "Running: screen -dmS $SESSION2 -c $SCREENRC2 /bin/sh -c 'echo hello-deflog'"
screen -dmS "$SESSION2" -c "$SCREENRC2" /bin/sh -c 'echo "hello-deflog"'

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
    echo "Log file EXISTS: $LOGFILE2"
    echo "Content: $(cat "$LOGFILE2")"
    rm -f "$LOGFILE2"
else
    echo "Log file NOT FOUND: $LOGFILE2"
    if [ -f "screenlog.0" ]; then
        echo "BUT screenlog.0 exists!"
        echo "Content: $(cat screenlog.0)"
        rm -f screenlog.0
    fi
fi

rm -f "$SCREENRC2"

echo ""
echo "=== Done ==="
