#!/usr/bin/env bun
/* global console */
/**
 * Experiment: Test command-stream with CommonJS require
 */

(async () => {
  console.log(
    '=== Testing command-stream with dynamic import in CommonJS ===\n'
  );

  // Need to use dynamic import since command-stream is ESM
  const { $ } = await import('command-stream');

  // Test 1: Basic sync command
  console.log('Test 1: Basic sync command');
  const result1 = $`echo "Hello from CJS"`.sync();
  console.log('stdout:', result1.stdout);
  console.log('exit code:', result1.code);
  console.log('');

  // Test 2: which command
  console.log('Test 2: which command');
  const result2 = $`which echo`.sync();
  console.log('stdout:', result2.stdout.trim());
  console.log('exit code:', result2.code);
  console.log('');

  console.log('=== All tests completed ===');
})();
