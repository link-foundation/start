#!/bin/bash
# Test script to reproduce the issue with direct command execution
# showing "executing" status instead of "executed"

set -e

# Use a temporary app folder for isolation
export START_APP_FOLDER="/tmp/start-test-issue51-$$"
echo "Using app folder: $START_APP_FOLDER"

# Clean up existing folder
rm -rf "$START_APP_FOLDER"

# Navigate to JS directory
cd "$(dirname "$0")/../js"

# Test 1: Execute a simple command directly (without isolation)
echo ""
echo "=== Test 1: Direct execution (no isolation) ==="
OUTPUT=$(bun src/bin/cli.js echo 'hello world')
echo "$OUTPUT"

# Extract UUID from output (first line)
UUID=$(echo "$OUTPUT" | head -1)
echo ""
echo "Extracted UUID: $UUID"

# Wait a moment for file writes to complete
sleep 1

# Query the status
echo ""
echo "=== Status query for direct execution ==="
bun src/bin/cli.js --status "$UUID" --output-format links-notation

# Show the raw execution store file
echo ""
echo "=== Raw execution store contents ==="
cat "$START_APP_FOLDER/executions.lino" 2>/dev/null || echo "No lino file found"

# Test 2: Execute with screen isolation (for comparison)
echo ""
echo "=== Test 2: Execution with screen isolation ==="
if command -v screen &> /dev/null; then
    OUTPUT2=$(bun src/bin/cli.js --isolated screen -- echo 'hello world' 2>&1 || true)
    echo "$OUTPUT2"

    UUID2=$(echo "$OUTPUT2" | head -1)
    echo ""
    echo "Extracted UUID: $UUID2"

    sleep 1

    echo ""
    echo "=== Status query for isolated execution ==="
    bun src/bin/cli.js --status "$UUID2" --output-format links-notation 2>&1 || true
else
    echo "screen not available, skipping isolation test"
fi

# Cleanup
echo ""
echo "=== Cleanup ==="
rm -rf "$START_APP_FOLDER"
echo "Done"
