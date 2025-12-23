#!/usr/bin/env bun
/**
 * Experiment to test different approaches for running screen in attached mode
 * from Bun without a TTY
 */

const { spawn, spawnSync, execSync } = require('child_process');

async function testApproaches() {
  console.log('=== Testing Attached Mode Approaches ===\n');

  // Approach 1: Using script command as wrapper
  console.log('Approach 1: script -q -c "screen ..." /dev/null');
  try {
    const sessionName = `approach1-${Date.now()}`;
    const result = spawnSync(
      'script',
      [
        '-q',
        '-c',
        `screen -S ${sessionName} /bin/sh -c "echo hello; exit 0"`,
        '/dev/null',
      ],
      {
        stdio: ['inherit', 'pipe', 'pipe'],
        timeout: 5000,
      }
    );
    console.log(
      `   stdout: "${result.stdout.toString().trim().replace(/\n/g, '\\n')}"`
    );
    console.log(
      `   stderr: "${result.stderr.toString().trim().replace(/\n/g, '\\n')}"`
    );
    console.log(`   exit: ${result.status}`);
    // Cleanup
    try {
      execSync(`screen -S ${sessionName} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`   Error: ${e.message}`);
  }
  console.log('');

  // Approach 2: Using detached mode + wait for completion + capture output via log
  console.log('Approach 2: detached + log capture');
  try {
    const sessionName = `approach2-${Date.now()}`;
    const logFile = `/tmp/screen-${sessionName}.log`;

    // Start with logging
    execSync(
      `screen -dmS ${sessionName} -L -Logfile ${logFile} /bin/sh -c "echo 'hello from approach2'"`,
      {
        stdio: 'inherit',
      }
    );

    // Wait for completion
    await new Promise((r) => setTimeout(r, 500));

    // Read log
    const output = execSync(`cat ${logFile}`, { encoding: 'utf8' });
    console.log(`   Output: "${output.trim()}"`);
    console.log(`   Status: SUCCESS`);

    // Cleanup
    try {
      execSync(`rm ${logFile} 2>/dev/null`);
    } catch {}
    try {
      execSync(`screen -S ${sessionName} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`   Error: ${e.message}`);
  }
  console.log('');

  // Approach 3: Using stdio: 'inherit' with proper terminal allocation via script
  console.log('Approach 3: Run through script, inherit all stdio');
  try {
    const sessionName = `approach3-${Date.now()}`;
    const result = spawnSync(
      'script',
      [
        '-q',
        '-e',
        '-c',
        `screen -S ${sessionName} /bin/sh -c "echo hello_approach3"`,
        '/dev/null',
      ],
      {
        stdio: 'inherit',
        timeout: 5000,
      }
    );
    console.log(`   exit: ${result.status}`);
    // Cleanup
    try {
      execSync(`screen -S ${sessionName} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`   Error: ${e.message}`);
  }
  console.log('');

  // Approach 4: Direct run without screen for attached mode (fallback)
  console.log(
    'Approach 4: Just spawn the shell command directly (fallback, no screen)'
  );
  try {
    const result = spawnSync('/bin/sh', ['-c', 'echo hello_direct'], {
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: 5000,
    });
    console.log(`   stdout: "${result.stdout.toString().trim()}"`);
    console.log(`   exit: ${result.status}`);
  } catch (e) {
    console.log(`   Error: ${e.message}`);
  }
  console.log('');

  console.log('=== Approaches Tested ===');
}

testApproaches();
