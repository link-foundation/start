#!/bin/bash
# Experiment to understand screen output behavior

echo "=== Test 1: Direct screen with command ==="
screen -S test1 /bin/sh -c 'echo "hello from test1"'

echo ""
echo "=== Test 2: Screen with -L logging ==="
cd /tmp
screen -L -Logfile screen-test.log -S test2 /bin/sh -c 'echo "hello from test2"'
echo "Log contents:"
cat /tmp/screen-test.log 2>/dev/null || echo "No log file created"

echo ""
echo "=== Test 3: Screen detached then capture ==="
screen -dmS test3 /bin/sh -c 'echo "hello from test3" > /tmp/screen-test3-out.txt'
sleep 0.5
echo "Output from test3:"
cat /tmp/screen-test3-out.txt 2>/dev/null || echo "No output file"

echo ""
echo "=== Test 4: Screen with wrap using script command ==="
script -q /dev/null -c 'screen -S test4 /bin/sh -c "echo hello from test4"' 2>/dev/null || echo "Script method failed"

echo ""
echo "Cleanup"
rm -f /tmp/screen-test.log /tmp/screen-test3-out.txt
