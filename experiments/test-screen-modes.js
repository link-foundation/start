#!/usr/bin/env node
/**
 * Experiment to test different screen invocation modes
 * This helps understand how screen behaves in different contexts
 */

const { spawn, execSync, spawnSync } = require('child_process');

async function testScreenModes() {
  console.log('=== Testing Screen Modes ===\n');

  // Test 1: Check if running in a terminal
  console.log('1. Terminal check:');
  console.log(`   process.stdin.isTTY: ${process.stdin.isTTY}`);
  console.log(`   process.stdout.isTTY: ${process.stdout.isTTY}`);
  console.log(`   TERM: ${process.env.TERM || 'not set'}`);
  console.log('');

  // Test 2: Detached mode should work
  console.log('2. Testing detached mode (screen -dmS):');
  try {
    const sessionName = `test-${Date.now()}`;
    execSync(
      `screen -dmS ${sessionName} /bin/sh -c "echo hello > /tmp/screen-test-${sessionName}.txt"`,
      {
        stdio: 'inherit',
      }
    );
    // Wait a bit for the command to complete
    await new Promise((r) => setTimeout(r, 200));

    const output = execSync(
      `cat /tmp/screen-test-${sessionName}.txt 2>/dev/null || echo "file not found"`,
      { encoding: 'utf8' }
    );
    console.log(`   Output: ${output.trim()}`);

    // Cleanup
    try {
      execSync(`screen -S ${sessionName} -X quit 2>/dev/null`);
    } catch {}
    try {
      execSync(`rm /tmp/screen-test-${sessionName}.txt 2>/dev/null`);
    } catch {}

    console.log('   Status: SUCCESS');
  } catch (e) {
    console.log(`   Status: FAILED - ${e.message}`);
  }
  console.log('');

  // Test 3: Attached mode with spawn (current implementation)
  console.log('3. Testing attached mode with spawn (current implementation):');
  try {
    const sessionName = `test-${Date.now()}`;
    const result = spawnSync(
      'screen',
      ['-S', sessionName, '/bin/sh', '-c', 'echo hello'],
      {
        stdio: 'inherit',
      }
    );
    console.log(`   Exit code: ${result.status}`);
    console.log(`   Status: ${result.status === 0 ? 'SUCCESS' : 'FAILED'}`);
  } catch (e) {
    console.log(`   Status: FAILED - ${e.message}`);
  }
  console.log('');

  // Test 4: Try to use script command to allocate PTY
  console.log('4. Testing with script command to allocate PTY:');
  try {
    const result = spawnSync(
      'script',
      ['-q', '-c', 'echo hello', '/dev/null'],
      {
        stdio: ['inherit', 'pipe', 'pipe'],
      }
    );
    console.log(`   Output: ${result.stdout.toString().trim()}`);
    console.log(`   Exit code: ${result.status}`);
    console.log(`   Status: SUCCESS`);
  } catch (e) {
    console.log(`   Status: FAILED - ${e.message}`);
  }
  console.log('');

  // Test 5: Detached mode with log capture
  console.log('5. Testing detached mode with log capture:');
  try {
    const sessionName = `test-${Date.now()}`;
    const logFile = `/tmp/screen-log-${sessionName}.txt`;

    // Create detached session with logging
    execSync(
      `screen -dmS ${sessionName} -L -Logfile ${logFile} /bin/sh -c "echo 'hello from screen'; sleep 0.2"`,
      {
        stdio: 'inherit',
      }
    );

    // Wait for command to complete
    await new Promise((r) => setTimeout(r, 500));

    const output = execSync(
      `cat ${logFile} 2>/dev/null || echo "log not found"`,
      { encoding: 'utf8' }
    );
    console.log(`   Log content: ${output.trim().replace(/\n/g, '\\n')}`);

    // Cleanup
    try {
      execSync(`screen -S ${sessionName} -X quit 2>/dev/null`);
    } catch {}
    try {
      execSync(`rm ${logFile} 2>/dev/null`);
    } catch {}

    console.log('   Status: SUCCESS');
  } catch (e) {
    console.log(`   Status: FAILED - ${e.message}`);
  }
  console.log('');

  console.log('=== Tests Complete ===');
}

testScreenModes();
