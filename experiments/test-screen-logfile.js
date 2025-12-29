#!/usr/bin/env bun
/**
 * Experiment to test screen's logfile capture functionality
 * to understand the root cause of issue #15
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testScreenLogfile() {
  console.log('=== Testing Screen Logfile Capture ===\n');

  // Test environment info
  console.log('Environment:');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Node: ${process.version}`);
  try {
    const screenVersion = execSync('screen --version', {
      encoding: 'utf8',
    }).trim();
    console.log(`  Screen: ${screenVersion}`);
  } catch (e) {
    console.log(`  Screen: Not available - ${e.message}`);
    return;
  }
  console.log(
    `  TTY: stdin=${process.stdin.isTTY}, stdout=${process.stdout.isTTY}`
  );
  console.log('');

  // Test 1: Basic logfile capture with -L -Logfile
  console.log('Test 1: Basic -L -Logfile capture');
  const sessionName1 = `logtest-${Date.now()}`;
  const logFile1 = path.join(os.tmpdir(), `screen-log-${sessionName1}.log`);

  try {
    // Run screen with logging
    const screenArgs = [
      '-dmS',
      sessionName1,
      '-L',
      '-Logfile',
      logFile1,
      '/bin/sh',
      '-c',
      'echo "TESTOUTPUT123"',
    ];

    console.log(`  Command: screen ${screenArgs.join(' ')}`);

    execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    // Wait for completion (screen runs command and exits)
    await sleep(500);

    // Check if session still exists
    let sessionExists = false;
    try {
      const sessions = execSync('screen -ls', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      sessionExists = sessions.includes(sessionName1);
    } catch {
      // screen -ls returns non-zero if no sessions
    }
    console.log(`  Session exists after 500ms: ${sessionExists}`);

    // Check log file
    if (fs.existsSync(logFile1)) {
      const content = fs.readFileSync(logFile1, 'utf8');
      console.log(`  Log file exists: YES`);
      console.log(`  Log file size: ${content.length} bytes`);
      console.log(
        `  Log content: "${content.trim().replace(/\n/g, '\\n').slice(0, 200)}"`
      );
      console.log(
        `  Contains expected output: ${content.includes('TESTOUTPUT123') ? 'YES ✓' : 'NO ✗'}`
      );
      fs.unlinkSync(logFile1);
    } else {
      console.log(`  Log file exists: NO ✗`);
      console.log(`  Expected path: ${logFile1}`);
    }

    // Cleanup
    try {
      execSync(`screen -S ${sessionName1} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 2: Test with sleep to ensure buffer flush
  console.log('Test 2: With sleep for buffer flush');
  const sessionName2 = `logtest2-${Date.now()}`;
  const logFile2 = path.join(os.tmpdir(), `screen-log-${sessionName2}.log`);

  try {
    const screenArgs = [
      '-dmS',
      sessionName2,
      '-L',
      '-Logfile',
      logFile2,
      '/bin/sh',
      '-c',
      'echo "FLUSHED_OUTPUT" && sleep 0.5',
    ];

    console.log(`  Command: screen ${screenArgs.join(' ')}`);

    execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    // Wait longer for flush (default is 10 seconds)
    await sleep(1500);

    // Check log file
    if (fs.existsSync(logFile2)) {
      const content = fs.readFileSync(logFile2, 'utf8');
      console.log(`  Log file exists: YES`);
      console.log(`  Log file size: ${content.length} bytes`);
      console.log(
        `  Contains expected output: ${content.includes('FLUSHED_OUTPUT') ? 'YES ✓' : 'NO ✗'}`
      );
      fs.unlinkSync(logFile2);
    } else {
      console.log(`  Log file exists: NO ✗`);
    }

    // Cleanup
    try {
      execSync(`screen -S ${sessionName2} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 3: Alternative - using hardstatus/output redirection
  console.log('Test 3: Direct command output capture (no screen logging)');
  const sessionName3 = `logtest3-${Date.now()}`;
  const logFile3 = path.join(os.tmpdir(), `screen-log-${sessionName3}.log`);

  try {
    // Run command through screen but capture output to file within the command
    const command = `echo "DIRECT_CAPTURE" | tee ${logFile3}`;
    const screenArgs = ['-dmS', sessionName3, '/bin/sh', '-c', command];

    console.log(`  Command: screen ${screenArgs.join(' ')}`);

    execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    await sleep(500);

    // Check log file
    if (fs.existsSync(logFile3)) {
      const content = fs.readFileSync(logFile3, 'utf8');
      console.log(`  Log file exists: YES`);
      console.log(
        `  Contains expected output: ${content.includes('DIRECT_CAPTURE') ? 'YES ✓' : 'NO ✗'}`
      );
      fs.unlinkSync(logFile3);
    } else {
      console.log(`  Log file exists: NO ✗`);
    }

    // Cleanup
    try {
      execSync(`screen -S ${sessionName3} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 4: Script command approach
  console.log('Test 4: Using script command to capture output');
  const sessionName4 = `logtest4-${Date.now()}`;
  const logFile4 = path.join(os.tmpdir(), `script-log-${sessionName4}.log`);

  try {
    // Use script to capture output
    const result = spawnSync(
      'script',
      [
        '-q',
        logFile4,
        '-c',
        `screen -dmS ${sessionName4} /bin/sh -c "echo SCRIPT_CAPTURE"`,
      ],
      {
        stdio: ['inherit', 'pipe', 'pipe'],
        timeout: 5000,
      }
    );

    await sleep(500);

    console.log(`  Exit code: ${result.status}`);

    // Check log file
    if (fs.existsSync(logFile4)) {
      const content = fs.readFileSync(logFile4, 'utf8');
      console.log(`  Log file exists: YES`);
      console.log(`  Log file size: ${content.length} bytes`);
      fs.unlinkSync(logFile4);
    } else {
      console.log(`  Log file exists: NO`);
    }

    // Cleanup
    try {
      execSync(`screen -S ${sessionName4} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 5: Test with -T option (terminal type)
  console.log('Test 5: With explicit terminal type -T xterm');
  const sessionName5 = `logtest5-${Date.now()}`;
  const logFile5 = path.join(os.tmpdir(), `screen-log-${sessionName5}.log`);

  try {
    const screenArgs = [
      '-T',
      'xterm',
      '-dmS',
      sessionName5,
      '-L',
      '-Logfile',
      logFile5,
      '/bin/sh',
      '-c',
      'echo "TERMINAL_OUTPUT" && sleep 0.3',
    ];

    console.log(`  Command: screen ${screenArgs.join(' ')}`);

    execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    await sleep(1000);

    // Check log file
    if (fs.existsSync(logFile5)) {
      const content = fs.readFileSync(logFile5, 'utf8');
      console.log(`  Log file exists: YES`);
      console.log(`  Log file size: ${content.length} bytes`);
      console.log(
        `  Contains expected output: ${content.includes('TERMINAL_OUTPUT') ? 'YES ✓' : 'NO ✗'}`
      );
      fs.unlinkSync(logFile5);
    } else {
      console.log(`  Log file exists: NO ✗`);
    }

    // Cleanup
    try {
      execSync(`screen -S ${sessionName5} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  console.log('=== Tests Complete ===');
}

testScreenLogfile();
