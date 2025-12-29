#!/bin/bash
# Test script for start-command CLI

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_PATH="${SCRIPT_DIR}/../bin/cli.js"

echo "=== Testing start-command CLI ==="
echo ""

# Test 1: No arguments - should show usage
echo "Test 1: No arguments (should show usage)"
node "$CLI_PATH" || true
echo ""

# Test 2: Successful command
echo "Test 2: Successful command (echo)"
node "$CLI_PATH" echo "Hello from test!"
echo ""

# Test 3: List directory
echo "Test 3: List directory (ls)"
node "$CLI_PATH" ls -la "$SCRIPT_DIR"
echo ""

# Test 4: Failing command (system command)
echo "Test 4: Failing system command (false) - should NOT detect repository"
node "$CLI_PATH" false || true
echo ""

# Test 5: Non-existent command
echo "Test 5: Non-existent command - should NOT detect repository"
node "$CLI_PATH" this_command_does_not_exist_xyz123 || true
echo ""

# Test 6: Check log file creation
echo "Test 6: Verify log files are created"
ls -la /tmp/start-command-*.log 2>/dev/null | head -5 || echo "No log files found (unexpected)"
echo ""

echo "=== All tests completed ==="
