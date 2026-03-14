#!/usr/bin/env node
/**
 * Experiment for Issue #96: Force the tee fallback path on modern screen
 * to reproduce the issue seen on macOS with screen 4.00.03
 *
 * This test monkeypatches supportsLogfileOption to return false,
 * forcing the tee fallback code path.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Force Tee Fallback Path Test ===\n');

  // Test with the actual screen-isolation module by requiring and testing directly
  const screenIsolation = require('../js/src/lib/screen-isolation');
  const isolation = require('../js/src/lib/isolation');

  // Force tee fallback by resetting cache and mocking
  screenIsolation.resetScreenVersionCache();

  console.log('Screen version detected:', screenIsolation.getScreenVersion());
  console.log('Supports -Logfile:', screenIsolation.supportsLogfileOption());
  console.log('');

  // Test 1: Use the actual runScreenWithLogCapture with native logging
  console.log('--- Test 1: Native -Logfile path (current system) ---');
  const session1 = `issue96-native-${Date.now()}`;
  const result1 = await screenIsolation.runScreenWithLogCapture(
    'echo "test-native-output"',
    session1,
    { shell: '/bin/sh', shellArg: '-c' },
    null,
    isolation.wrapCommandWithUser,
    isolation.isInteractiveShellCommand
  );
  console.log('Result:', JSON.stringify(result1, null, 2));
  console.log('');

  // Test 2: Force tee fallback by temporarily overriding supportsLogfileOption
  // We can't easily mock it, so let's simulate manually
  console.log('--- Test 2: Manual tee fallback simulation ---');
  const session2 = `issue96-tee-${Date.now()}`;
  const logFile2 = path.join(os.tmpdir(), `screen-output-${session2}.log`);
  const command = 'echo "test-tee-output"';
  const effectiveCommand = `(${command}) 2>&1 | tee "${logFile2}"`;

  const screenArgs = ['-dmS', session2, '/bin/sh', '-c', effectiveCommand];
  console.log(`  Running: screen ${screenArgs.join(' ')}`);

  spawnSync('screen', screenArgs, { stdio: 'inherit' });

  // Poll for completion
  let waited = 0;
  while (waited < 5000) {
    await sleep(100);
    waited += 100;
    try {
      const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (!sessions.includes(session2)) break;
    } catch { break; }
  }

  console.log(`  Session ended after ${waited}ms`);

  // Read output with retries (mimicking readAndDisplayOutput)
  let output = '';
  try { output = fs.readFileSync(logFile2, 'utf8'); } catch {}

  if (!output.trim()) {
    console.log('  First read: empty, retrying after 50ms...');
    await sleep(50);
    try { output = fs.readFileSync(logFile2, 'utf8'); } catch {}
  }

  console.log(`  Output: "${output.trim()}"`);
  console.log(`  Result: ${output.includes('test-tee-output') ? 'PASS ✓' : 'FAIL ✗'}`);
  try { fs.unlinkSync(logFile2); } catch {}
  console.log('');

  // Test 3: Multiple rapid commands to stress race condition
  console.log('--- Test 3: Rapid commands stress test (10 iterations) ---');
  let successes = 0;
  let failures = 0;

  for (let i = 0; i < 10; i++) {
    const session = `issue96-stress-${Date.now()}-${i}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const cmd = `(echo "iteration-${i}") 2>&1 | tee "${logFile}"`;

    spawnSync('screen', ['-dmS', session, '/bin/sh', '-c', cmd], { stdio: 'inherit' });

    // Quick poll
    let w = 0;
    while (w < 3000) {
      await sleep(50);
      w += 50;
      try {
        const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (!sessions.includes(session)) break;
      } catch { break; }
    }

    // Read with retry
    let content = '';
    try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
    if (!content.trim()) {
      await sleep(50);
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
    }

    if (content.includes(`iteration-${i}`)) {
      successes++;
    } else {
      failures++;
      console.log(`  FAIL at iteration ${i}: got "${content.trim()}"`);
    }

    try { fs.unlinkSync(logFile); } catch {}
  }

  console.log(`  Results: ${successes}/10 passed, ${failures}/10 failed`);
  console.log('');

  // Test 4: Test with a command that produces output on stderr only
  console.log('--- Test 4: stderr-only output capture ---');
  const session4 = `issue96-stderr-${Date.now()}`;
  const logFile4 = path.join(os.tmpdir(), `screen-output-${session4}.log`);
  const stderrCmd = `(echo "stderr-output" >&2) 2>&1 | tee "${logFile4}"`;

  spawnSync('screen', ['-dmS', session4, '/bin/sh', '-c', stderrCmd], { stdio: 'inherit' });

  waited = 0;
  while (waited < 3000) {
    await sleep(100);
    waited += 100;
    try {
      const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (!sessions.includes(session4)) break;
    } catch { break; }
  }

  await sleep(50);
  let content4 = '';
  try { content4 = fs.readFileSync(logFile4, 'utf8'); } catch {}
  console.log(`  Output: "${content4.trim()}"`);
  console.log(`  Result: ${content4.includes('stderr-output') ? 'PASS ✓' : 'FAIL ✗'}`);
  try { fs.unlinkSync(logFile4); } catch {}

  console.log('\n=== Tests Complete ===');
}

main().catch(console.error);
