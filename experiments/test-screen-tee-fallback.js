#!/usr/bin/env bun
/**
 * Experiment to test screen's tee fallback functionality
 * This simulates the behavior on macOS with older screen (< 4.5.1)
 * which doesn't support -Logfile option
 *
 * Issue #25: We don't get `Hello` output from `$ --isolated screen --verbose -- echo "hello"` command
 */

const { execSync, spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testTeeFallback() {
  console.log('=== Testing Screen Tee Fallback (macOS 4.0.3 simulation) ===\n');

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

  // Test 1: The tee fallback approach (current implementation for macOS)
  console.log('Test 1: Tee fallback approach (current implementation)');
  const sessionName1 = `tee-test-${Date.now()}`;
  const logFile1 = path.join(os.tmpdir(), `screen-tee-${sessionName1}.log`);
  const command = 'echo "hello"';

  try {
    // This is the current implementation for older screen versions
    const effectiveCommand = `(${command}) 2>&1 | tee "${logFile1}"`;
    const shell = '/bin/sh';
    const shellArg = '-c';
    const screenArgs = [
      '-dmS',
      sessionName1,
      shell,
      shellArg,
      effectiveCommand,
    ];

    console.log(`  Command: screen ${screenArgs.join(' ')}`);
    console.log(`  Effective command inside screen: ${effectiveCommand}`);

    execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    // Wait for completion and poll for session
    let waited = 0;
    const maxWait = 5000;
    const interval = 100;

    while (waited < maxWait) {
      await sleep(interval);
      waited += interval;

      try {
        const sessions = execSync('screen -ls', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!sessions.includes(sessionName1)) {
          console.log(`  Session ended after ${waited}ms`);
          break;
        }
      } catch {
        // screen -ls returns non-zero if no sessions
        console.log(`  Session ended after ${waited}ms (no sessions)`);
        break;
      }
    }

    // Check log file
    if (fs.existsSync(logFile1)) {
      const content = fs.readFileSync(logFile1, 'utf8');
      console.log(`  Log file exists: YES`);
      console.log(`  Log file size: ${content.length} bytes`);
      console.log(`  Log content: "${content.trim()}"`);
      console.log(
        `  Contains expected output: ${content.includes('hello') ? 'YES ✓' : 'NO ✗'}`
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

  // Test 2: Test the attached mode WITHOUT TTY (hasTTY() returns false)
  console.log(
    'Test 2: Simulating attached mode without TTY (current code path)'
  );
  const sessionName2 = `tee-notty-${Date.now()}`;
  const logFile2 = path.join(os.tmpdir(), `screen-tee-${sessionName2}.log`);

  try {
    // Simulate the runScreenWithLogCapture function behavior for older screen
    const command2 = 'echo "hello from attached mode"';
    const effectiveCommand2 = `(${command2}) 2>&1 | tee "${logFile2}"`;
    const shell = '/bin/sh';
    const shellArg = '-c';
    const screenArgs = [
      '-dmS',
      sessionName2,
      shell,
      shellArg,
      effectiveCommand2,
    ];

    console.log(`  Screen args: ${screenArgs.join(' ')}`);

    execSync(`screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`, {
      stdio: 'inherit',
    });

    // Poll for session completion (as done in current implementation)
    const checkInterval = 100;
    const maxWait = 5000;
    let waited = 0;

    const checkCompletion = async () => {
      while (waited < maxWait) {
        await sleep(checkInterval);
        waited += checkInterval;

        try {
          const sessions = execSync('screen -ls', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          if (!sessions.includes(sessionName2)) {
            break;
          }
        } catch {
          break;
        }
      }
    };

    await checkCompletion();
    console.log(`  Session ended after ${waited}ms`);

    // Read output
    if (fs.existsSync(logFile2)) {
      const content = fs.readFileSync(logFile2, 'utf8');
      console.log(`  Log file exists: YES`);
      console.log(`  Log content: "${content.trim()}"`);
      console.log(
        `  Contains expected: ${content.includes('hello from attached mode') ? 'YES ✓' : 'NO ✗'}`
      );
      fs.unlinkSync(logFile2);
    } else {
      console.log(`  Log file exists: NO ✗`);
    }

    try {
      execSync(`screen -S ${sessionName2} -X quit 2>/dev/null`);
    } catch {}
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 3: What happens if we have a TTY?
  console.log('Test 3: Test with attached mode WITH TTY (spawn with inherit)');
  const sessionName3 = `tty-test-${Date.now()}`;

  try {
    const command3 = 'echo "hello TTY"';
    const screenArgs = ['-S', sessionName3, '/bin/sh', '-c', command3];

    console.log(`  Screen args for attached mode: ${screenArgs.join(' ')}`);
    console.log(
      `  hasTTY: stdin=${process.stdin.isTTY}, stdout=${process.stdout.isTTY}`
    );

    // This mimics what the current code does when hasTTY() returns true
    return new Promise((resolve) => {
      const child = spawn('screen', screenArgs, {
        stdio: 'inherit',
      });

      child.on('exit', (code) => {
        console.log(`  Exit code: ${code}`);
        console.log(
          `  Note: In attached mode with TTY, output goes directly to terminal`
        );
        resolve();
      });

      child.on('error', (err) => {
        console.log(`  Error: ${err.message}`);
        resolve();
      });
    });
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  console.log('=== Tests Complete ===');
}

testTeeFallback();
