#!/usr/bin/env node
/**
 * Experiment for Issue #96: Use screenrc-based logging instead of -Logfile or tee
 *
 * This approach works on ALL screen versions (including macOS 4.00.03):
 * - Create a screenrc with: logfile <path>, logfile flush 0, log on
 * - Run: screen -dmS <session> -c <screenrc> <shell> -c '<command>'
 * - No need for -L -Logfile flags or tee fallback
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test(label, fn) {
  console.log(`\n--- ${label} ---`);
  try {
    await fn();
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    console.log(`  STACK: ${e.stack}`);
  }
}

async function main() {
  console.log('=== Test: screenrc-based logging (universal approach) ===\n');

  let screenVersion;
  try {
    screenVersion = execSync('screen --version', { encoding: 'utf8' }).trim();
  } catch (e) {
    console.log('Screen not available. Exiting.');
    return;
  }
  console.log(`Screen: ${screenVersion}`);
  console.log(`Platform: ${process.platform}`);
  console.log('');

  // Test 1: screenrc-based logging with echo
  await test('Test 1: screenrc logging with echo', async () => {
    const session = `test-rc-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const screenrcFile = path.join(os.tmpdir(), `screenrc-${session}`);

    // Create screenrc with logging configuration
    const screenrcContent = [
      `logfile ${logFile}`,
      'logfile flush 0',
      'log on',
      ''
    ].join('\n');

    fs.writeFileSync(screenrcFile, screenrcContent);
    console.log(`  screenrc content:\n${screenrcContent.split('\n').map(l => `    ${l}`).join('\n')}`);

    // Run screen with screenrc-based logging (no -L, no -Logfile, no tee)
    const args = ['-dmS', session, '-c', screenrcFile, '/bin/sh', '-c', 'echo "hello screenrc"'];
    console.log(`  screen ${args.join(' ')}`);

    spawnSync('screen', args, { stdio: 'inherit' });

    // Poll for completion
    let waited = 0;
    while (waited < 5000) {
      await sleep(100);
      waited += 100;
      try {
        const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (!sessions.includes(session)) break;
      } catch { break; }
    }
    console.log(`  Session ended after ${waited}ms`);

    // Read log file
    let content = '';
    try { content = fs.readFileSync(logFile, 'utf8'); } catch (e) { console.log(`  Log read error: ${e.message}`); }
    console.log(`  Log content: "${content.trim()}" (${content.length} bytes)`);
    console.log(`  Result: ${content.includes('hello screenrc') ? 'PASS ✓' : 'FAIL ✗'}`);

    // Cleanup
    try { fs.unlinkSync(logFile); } catch {}
    try { fs.unlinkSync(screenrcFile); } catch {}
  });

  // Test 2: screenrc-based logging with a fast command (simulating agent --version)
  await test('Test 2: screenrc logging with fast command (node --version)', async () => {
    const session = `test-rc-fast-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const screenrcFile = path.join(os.tmpdir(), `screenrc-${session}`);

    const screenrcContent = `logfile ${logFile}\nlogfile flush 0\nlog on\n`;
    fs.writeFileSync(screenrcFile, screenrcContent);

    const args = ['-dmS', session, '-c', screenrcFile, '/bin/sh', '-c', 'node --version'];
    console.log(`  screen ${args.join(' ')}`);

    spawnSync('screen', args, { stdio: 'inherit' });

    let waited = 0;
    while (waited < 5000) {
      await sleep(100);
      waited += 100;
      try {
        const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (!sessions.includes(session)) break;
      } catch { break; }
    }
    console.log(`  Session ended after ${waited}ms`);

    let content = '';
    try { content = fs.readFileSync(logFile, 'utf8'); } catch (e) { console.log(`  Read error: ${e.message}`); }
    console.log(`  Log content: "${content.trim()}" (${content.length} bytes)`);

    const nodeVersion = execSync('node --version', { encoding: 'utf8' }).trim();
    console.log(`  Expected (node --version): ${nodeVersion}`);
    console.log(`  Result: ${content.includes(nodeVersion) ? 'PASS ✓' : 'FAIL ✗'}`);

    try { fs.unlinkSync(logFile); } catch {}
    try { fs.unlinkSync(screenrcFile); } catch {}
  });

  // Test 3: screenrc-based logging with exit code capture
  await test('Test 3: Exit code capture via screenrc approach', async () => {
    const session = `test-rc-exit-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const exitFile = path.join(os.tmpdir(), `screen-exit-${session}.code`);
    const screenrcFile = path.join(os.tmpdir(), `screenrc-${session}`);

    const screenrcContent = `logfile ${logFile}\nlogfile flush 0\nlog on\n`;
    fs.writeFileSync(screenrcFile, screenrcContent);

    // Wrap command to capture exit code
    const innerCmd = 'node --version';
    const wrappedCmd = `${innerCmd}; echo "EXIT_CODE:$?" > "${exitFile}"`;

    const args = ['-dmS', session, '-c', screenrcFile, '/bin/sh', '-c', wrappedCmd];
    console.log(`  Wrapped command: ${wrappedCmd}`);

    spawnSync('screen', args, { stdio: 'inherit' });

    let waited = 0;
    while (waited < 5000) {
      await sleep(100);
      waited += 100;
      try {
        const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (!sessions.includes(session)) break;
      } catch { break; }
    }

    // Extra wait for file flush
    await sleep(100);

    let logContent = '';
    try { logContent = fs.readFileSync(logFile, 'utf8'); } catch {}
    let exitContent = '';
    try { exitContent = fs.readFileSync(exitFile, 'utf8'); } catch {}

    console.log(`  Log content: "${logContent.trim()}"`);
    console.log(`  Exit code file: "${exitContent.trim()}"`);
    console.log(`  Result: ${exitContent.includes('EXIT_CODE:0') ? 'PASS ✓' : 'FAIL ✗'}`);

    try { fs.unlinkSync(logFile); } catch {}
    try { fs.unlinkSync(exitFile); } catch {}
    try { fs.unlinkSync(screenrcFile); } catch {}
  });

  // Test 4: screenrc-based logging with failed command (exit code capture)
  await test('Test 4: Failed command exit code capture', async () => {
    const session = `test-rc-fail-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const exitFile = path.join(os.tmpdir(), `screen-exit-${session}.code`);
    const screenrcFile = path.join(os.tmpdir(), `screenrc-${session}`);

    const screenrcContent = `logfile ${logFile}\nlogfile flush 0\nlog on\n`;
    fs.writeFileSync(screenrcFile, screenrcContent);

    const innerCmd = 'nonexistent_command_12345 --version';
    const wrappedCmd = `${innerCmd}; echo "EXIT_CODE:$?" > "${exitFile}"`;

    const args = ['-dmS', session, '-c', screenrcFile, '/bin/sh', '-c', wrappedCmd];
    spawnSync('screen', args, { stdio: 'inherit' });

    let waited = 0;
    while (waited < 5000) {
      await sleep(100);
      waited += 100;
      try {
        const sessions = execSync('screen -ls', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        if (!sessions.includes(session)) break;
      } catch { break; }
    }

    await sleep(100);

    let logContent = '';
    try { logContent = fs.readFileSync(logFile, 'utf8'); } catch {}
    let exitContent = '';
    try { exitContent = fs.readFileSync(exitFile, 'utf8'); } catch {}

    console.log(`  Log content: "${logContent.trim()}"`);
    console.log(`  Exit code file: "${exitContent.trim()}"`);
    // Should have non-zero exit code (127 for command not found)
    const exitCode = exitContent.match(/EXIT_CODE:(\d+)/)?.[1];
    console.log(`  Exit code: ${exitCode}`);
    console.log(`  Result: ${exitCode && exitCode !== '0' ? 'PASS ✓' : 'FAIL ✗'}`);

    try { fs.unlinkSync(logFile); } catch {}
    try { fs.unlinkSync(exitFile); } catch {}
    try { fs.unlinkSync(screenrcFile); } catch {}
  });

  // Test 5: Stress test - 20 rapid iterations
  await test('Test 5: Stress test (20 rapid iterations)', async () => {
    let successes = 0;
    let failures = 0;

    for (let i = 0; i < 20; i++) {
      const session = `test-rc-stress-${Date.now()}-${i}`;
      const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
      const screenrcFile = path.join(os.tmpdir(), `screenrc-${session}`);

      const screenrcContent = `logfile ${logFile}\nlogfile flush 0\nlog on\n`;
      fs.writeFileSync(screenrcFile, screenrcContent);

      const args = ['-dmS', session, '-c', screenrcFile, '/bin/sh', '-c', `echo "iter-${i}"`];
      spawnSync('screen', args, { stdio: 'inherit' });

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
      if (!content.includes(`iter-${i}`)) {
        await sleep(100);
        try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      }

      if (content.includes(`iter-${i}`)) {
        successes++;
      } else {
        failures++;
        console.log(`  FAIL at iteration ${i}: got "${content.trim()}"`);
      }

      try { fs.unlinkSync(logFile); } catch {}
      try { fs.unlinkSync(screenrcFile); } catch {}
    }

    console.log(`  Results: ${successes}/20 passed, ${failures}/20 failed`);
  });

  console.log('\n=== Tests Complete ===');
}

main().catch(console.error);
