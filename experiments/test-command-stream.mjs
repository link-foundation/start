#!/usr/bin/env bun
/**
 * Experiment: Test command-stream basic usage
 */

import { $ } from 'command-stream';

console.log('=== Testing command-stream ===\n');

// Test 1: Basic async command
console.log('Test 1: Basic async command');
const result1 = await $`echo "Hello from command-stream"`;
console.log('stdout:', result1.stdout);
console.log('exit code:', result1.code);
console.log('');

// Test 2: Sync command
console.log('Test 2: Sync command');
const result2 = $`echo "Sync hello"`.sync();
console.log('stdout:', result2.stdout);
console.log('exit code:', result2.code);
console.log('');

// Test 3: Command that uses system tools
console.log('Test 3: which command');
try {
  const result3 = $`which echo`.sync();
  console.log('stdout:', result3.stdout);
  console.log('exit code:', result3.code);
} catch (e) {
  console.log('Error:', e.message);
}
console.log('');

// Test 4: Get OS version on Linux
console.log('Test 4: uname command');
const result4 = $`uname -r`.sync();
console.log('stdout:', result4.stdout.trim());
console.log('exit code:', result4.code);
console.log('');

// Test 5: Silent mode (no mirror)
console.log('Test 5: Silent mode with $({ mirror: false })');
const $silent = $({ mirror: false, capture: true });
const result5 = await $silent`echo "This should be silent"`;
console.log('stdout:', result5.stdout);
console.log('');

// Test 6: Check if command exists
console.log('Test 6: Check if screen exists');
const result6 = $`which screen`.sync();
console.log('screen exists:', result6.code === 0);
console.log('screen path:', result6.stdout.trim());
console.log('');

console.log('=== All tests completed ===');
