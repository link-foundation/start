#!/usr/bin/env bun

/**
 * Test: Compare Bun.spawn vs node:child_process.spawn event handling
 *
 * Hypothesis: Bun's native spawn API properly keeps the event loop alive,
 * while node:child_process compatibility may not.
 */

console.log('=== Bun.spawn vs node:child_process Event Test ===');
console.log(`Bun version: ${Bun.version}`);
console.log(`Platform: ${process.platform}`);
console.log('');

const shell = process.env.SHELL || '/bin/sh';
const cmd = "echo 'hi'";

// Test 1: Using node:child_process
console.log('--- Test 1: node:child_process.spawn ---');
async function testNodeSpawn() {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const start = Date.now();

    const child = spawn(shell, ['-c', cmd], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', (code) => {
      console.log(`  close event fired after ${Date.now() - start}ms`);
      console.log(`  stdout: ${JSON.stringify(stdout)}`);
      console.log(`  exit code: ${code}`);
      resolve({ stdout, code });
    });

    child.on('error', (err) => {
      console.log(`  ERROR: ${err.message}`);
      resolve({ error: err.message });
    });

    // Timeout safety
    setTimeout(() => {
      console.log('  TIMEOUT: close event never fired');
      resolve({ timeout: true });
    }, 3000);
  });
}

// Test 2: Using Bun.spawn
console.log('--- Test 2: Bun.spawn ---');
async function testBunSpawn() {
  const start = Date.now();

  const proc = Bun.spawn([shell, '-c', cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Read stdout
  const stdout = await new Response(proc.stdout).text();

  // Wait for process to exit
  const exitCode = await proc.exited;

  console.log(`  completed after ${Date.now() - start}ms`);
  console.log(`  stdout: ${JSON.stringify(stdout)}`);
  console.log(`  exit code: ${exitCode}`);

  return { stdout, code: exitCode };
}

// Run both tests
async function runTests() {
  console.log('');
  const result1 = await testNodeSpawn();
  console.log('');
  const result2 = await testBunSpawn();
  console.log('');

  console.log('--- Comparison ---');
  console.log(`node:child_process: ${result1.timeout ? 'TIMEOUT' : result1.error ? 'ERROR' : 'OK'}`);
  console.log(`Bun.spawn: ${result2.error ? 'ERROR' : 'OK'}`);

  if (result1.timeout) {
    console.log('');
    console.log('CONCLUSION: node:child_process close event did not fire on this platform.');
    console.log('This confirms the root cause of Issue #57.');
  }
}

runTests();
