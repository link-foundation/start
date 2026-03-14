#!/usr/bin/env node
/**
 * Experiment for Issue #96: agent --version doesn't show output in screen isolation
 *
 * Tests both native -Logfile and tee fallback paths to identify root cause.
 * Also tests the race condition between session ending and log file availability.
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
  }
}

async function main() {
  console.log('=== Issue #96: Screen Output Capture Investigation ===\n');

  // Environment info
  let screenVersion;
  try {
    screenVersion = execSync('screen --version', { encoding: 'utf8' }).trim();
  } catch (e) {
    console.log('Screen not available. Exiting.');
    return;
  }

  console.log(`Platform: ${process.platform}`);
  console.log(`Screen: ${screenVersion}`);
  console.log(`Shell (SHELL env): ${process.env.SHELL || '(not set)'}`);
  console.log(`Temp dir: ${os.tmpdir()}`);

  // Test 1: Basic tee fallback (simulating macOS screen 4.00.03)
  await test('Test 1: Tee fallback with echo (should always work)', async () => {
    const session = `test96-tee-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const cmd = `(echo "hello world") 2>&1 | tee "${logFile}"`;

    const args = ['-dmS', session, '/bin/sh', '-c', cmd];
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

    // Read log file immediately
    let content = '';
    try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
    console.log(`  Log content (immediate): "${content.trim()}" (${content.length} bytes)`);

    // Retry after 50ms
    if (!content.trim()) {
      await sleep(50);
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      console.log(`  Log content (after 50ms retry): "${content.trim()}" (${content.length} bytes)`);
    }

    // Retry after 200ms
    if (!content.trim()) {
      await sleep(200);
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      console.log(`  Log content (after 200ms retry): "${content.trim()}" (${content.length} bytes)`);
    }

    console.log(`  Result: ${content.includes('hello world') ? 'PASS ✓' : 'FAIL ✗'}`);
    try { fs.unlinkSync(logFile); } catch {}
  });

  // Test 2: Native -Logfile with echo
  await test('Test 2: Native -Logfile with echo', async () => {
    const session = `test96-native-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const screenrcFile = path.join(os.tmpdir(), `screenrc-${session}`);

    // Create screenrc with logfile flush 0
    fs.writeFileSync(screenrcFile, 'logfile flush 0\n');

    const args = ['-dmS', session, '-c', screenrcFile, '-L', '-Logfile', logFile, '/bin/sh', '-c', 'echo "hello native"'];
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
    try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
    console.log(`  Log content (immediate): "${content.trim()}" (${content.length} bytes)`);

    if (!content.trim()) {
      await sleep(50);
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      console.log(`  Log content (after 50ms retry): "${content.trim()}" (${content.length} bytes)`);
    }

    if (!content.trim()) {
      await sleep(200);
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      console.log(`  Log content (after 200ms retry): "${content.trim()}" (${content.length} bytes)`);
    }

    console.log(`  Result: ${content.includes('hello native') ? 'PASS ✓' : 'FAIL ✗'}`);
    try { fs.unlinkSync(logFile); } catch {}
    try { fs.unlinkSync(screenrcFile); } catch {}
  });

  // Test 3: Native -Logfile WITHOUT screenrc (logfile flush 0)
  await test('Test 3: Native -Logfile WITHOUT logfile flush 0 (original bug scenario)', async () => {
    const session = `test96-noflush-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);

    const args = ['-dmS', session, '-L', '-Logfile', logFile, '/bin/sh', '-c', 'echo "hello noflush"'];
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
    try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
    console.log(`  Log content (immediate): "${content.trim()}" (${content.length} bytes)`);

    if (!content.trim()) {
      await sleep(100);
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      console.log(`  Log content (after 100ms retry): "${content.trim()}" (${content.length} bytes)`);
    }

    if (!content.trim()) {
      await sleep(500);
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      console.log(`  Log content (after 500ms retry): "${content.trim()}" (${content.length} bytes)`);
    }

    console.log(`  Result: ${content.includes('hello noflush') ? 'PASS ✓' : 'FAIL ✗'}`);
    try { fs.unlinkSync(logFile); } catch {}
  });

  // Test 4: Test with a command that's NOT in PATH (simulating agent not found)
  await test('Test 4: Command not in PATH (tee fallback)', async () => {
    const session = `test96-notfound-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const cmd = `(nonexistent_command_12345 --version) 2>&1 | tee "${logFile}"`;

    const args = ['-dmS', session, '/bin/sh', '-c', cmd];
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
    try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
    console.log(`  Log content: "${content.trim()}" (${content.length} bytes)`);
    console.log(`  Shows error: ${content.includes('not found') || content.includes('No such') ? 'YES ✓' : 'NO ✗'}`);
    try { fs.unlinkSync(logFile); } catch {}
  });

  // Test 5: Test race condition with multiple retries and longer delays
  await test('Test 5: Race condition with extended retries (tee)', async () => {
    const session = `test96-race-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const cmd = `(echo "race test output") 2>&1 | tee "${logFile}"`;

    const args = ['-dmS', session, '/bin/sh', '-c', cmd];
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

    // Try reading at different intervals
    const intervals = [0, 10, 50, 100, 200, 500, 1000];
    for (const delay of intervals) {
      if (delay > 0) await sleep(delay);
      let content = '';
      try { content = fs.readFileSync(logFile, 'utf8'); } catch {}
      const hasContent = content.trim().length > 0;
      console.log(`  After ${delay}ms: ${hasContent ? `"${content.trim()}"` : '(empty)'}`);
      if (hasContent) break;
    }

    try { fs.unlinkSync(logFile); } catch {}
  });

  // Test 6: Test if exit code can be captured
  await test('Test 6: Exit code capture (currently always reports 0)', async () => {
    const session = `test96-exit-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const exitFile = path.join(os.tmpdir(), `screen-exit-${session}.code`);

    // Modified command that saves exit code
    const innerCmd = 'nonexistent_command_12345 --version';
    const cmd = `(${innerCmd}) 2>&1 | tee "${logFile}"; echo $? > "${exitFile}"`;

    const args = ['-dmS', session, '/bin/sh', '-c', cmd];
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

    await sleep(100); // extra wait for file flush

    let exitCode = 'unknown';
    try { exitCode = fs.readFileSync(exitFile, 'utf8').trim(); } catch {}
    let logContent = '';
    try { logContent = fs.readFileSync(logFile, 'utf8').trim(); } catch {}

    console.log(`  Inner command exit code: ${exitCode}`);
    console.log(`  Log content: "${logContent}"`);
    console.log(`  Note: Current code always reports exit code 0 regardless`);

    try { fs.unlinkSync(logFile); } catch {}
    try { fs.unlinkSync(exitFile); } catch {}
  });

  // Test 7: Test with PIPESTATUS to get correct exit code through pipe
  await test('Test 7: PIPESTATUS for exit code through tee pipe', async () => {
    const session = `test96-pipe-${Date.now()}`;
    const logFile = path.join(os.tmpdir(), `screen-output-${session}.log`);
    const exitFile = path.join(os.tmpdir(), `screen-exit-${session}.code`);

    // Using bash PIPESTATUS to get exit code from before the pipe
    const innerCmd = 'nonexistent_command_12345 --version';
    const cmd = `(${innerCmd}) 2>&1 | tee "${logFile}"; echo \${PIPESTATUS[0]} > "${exitFile}"`;

    const args = ['-dmS', session, '/bin/bash', '-c', cmd];
    console.log(`  Using bash for PIPESTATUS support`);
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

    let exitCode = 'unknown';
    try { exitCode = fs.readFileSync(exitFile, 'utf8').trim(); } catch {}
    let logContent = '';
    try { logContent = fs.readFileSync(logFile, 'utf8').trim(); } catch {}

    console.log(`  PIPESTATUS exit code: ${exitCode}`);
    console.log(`  Log content: "${logContent}"`);

    try { fs.unlinkSync(logFile); } catch {}
    try { fs.unlinkSync(exitFile); } catch {}
  });

  console.log('\n=== Investigation Complete ===');
}

main().catch(console.error);
