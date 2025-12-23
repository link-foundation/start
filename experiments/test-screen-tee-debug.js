#!/usr/bin/env bun
/**
 * Debug experiment to find the root cause of issue #25
 * We're testing different ways of running screen commands with tee
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testDebug() {
  console.log('=== Debugging Screen Tee Fallback ===\n');

  // Test 1: Simple command without quotes issues
  console.log('Test 1: Simple command (no spaces in the command)');
  const sessionName1 = `debug1-${Date.now()}`;
  const logFile1 = path.join(os.tmpdir(), `debug1-${sessionName1}.log`);

  try {
    // Direct screen command with tee
    const cmd = `screen -dmS "${sessionName1}" /bin/sh -c "(echo hello) 2>&1 | tee \\"${logFile1}\\""`;
    console.log(`  Command: ${cmd}`);

    execSync(cmd, { stdio: 'inherit' });
    await sleep(500);

    if (fs.existsSync(logFile1)) {
      console.log(
        `  Log content: "${fs.readFileSync(logFile1, 'utf8').trim()}"`
      );
      console.log(`  Result: SUCCESS ✓`);
      fs.unlinkSync(logFile1);
    } else {
      console.log(`  Result: FAILED - No log file ✗`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 2: Command with nested quotes
  console.log('Test 2: Command with "hello" (has quotes)');
  const sessionName2 = `debug2-${Date.now()}`;
  const logFile2 = path.join(os.tmpdir(), `debug2-${sessionName2}.log`);

  try {
    // Note: The original command has quotes: echo "hello"
    // When we wrap it with tee, the quoting becomes complex
    const cmd = `screen -dmS "${sessionName2}" /bin/sh -c "(echo \\"hello\\") 2>&1 | tee \\"${logFile2}\\""`;
    console.log(`  Command: ${cmd}`);

    execSync(cmd, { stdio: 'inherit' });
    await sleep(500);

    if (fs.existsSync(logFile2)) {
      console.log(
        `  Log content: "${fs.readFileSync(logFile2, 'utf8').trim()}"`
      );
      console.log(`  Result: SUCCESS ✓`);
      fs.unlinkSync(logFile2);
    } else {
      console.log(`  Result: FAILED - No log file ✗`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 3: Using array-based command (like the current implementation)
  console.log('Test 3: Using array-based args (current implementation style)');
  const sessionName3 = `debug3-${Date.now()}`;
  const logFile3 = path.join(os.tmpdir(), `debug3-${sessionName3}.log`);

  try {
    // This is what the current code does
    const command = 'echo "hello"';
    const effectiveCommand = `(${command}) 2>&1 | tee "${logFile3}"`;
    const screenArgs = [
      '-dmS',
      sessionName3,
      '/bin/sh',
      '-c',
      effectiveCommand,
    ];

    // Construct the command string as the code does
    const cmdStr = `screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`;
    console.log(`  Constructed command: ${cmdStr}`);

    execSync(cmdStr, { stdio: 'inherit' });
    await sleep(500);

    if (fs.existsSync(logFile3)) {
      console.log(
        `  Log content: "${fs.readFileSync(logFile3, 'utf8').trim()}"`
      );
      console.log(`  Result: SUCCESS ✓`);
      fs.unlinkSync(logFile3);
    } else {
      console.log(`  Result: FAILED - No log file ✗`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 4: Check what happens with the nested quotes
  console.log('Test 4: Checking quote escaping issue');
  const sessionName4 = `debug4-${Date.now()}`;
  const logFile4 = path.join(os.tmpdir(), `debug4-${sessionName4}.log`);

  try {
    const command = 'echo "hello from attached mode"';
    const effectiveCommand = `(${command}) 2>&1 | tee "${logFile4}"`;
    console.log(`  effectiveCommand: ${effectiveCommand}`);

    // When we quote each arg with `"${a}"`, the command becomes double-quoted
    // which can cause issues with nested quotes
    const screenArgs = [
      '-dmS',
      sessionName4,
      '/bin/sh',
      '-c',
      effectiveCommand,
    ];
    const cmdStr = `screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`;
    console.log(`  Full command: ${cmdStr}`);

    // The problem: effectiveCommand has double quotes inside,
    // and we're wrapping it with MORE double quotes
    // This results in: screen "-dmS" "debug4-xxx" "/bin/sh" "-c" "(echo "hello from attached mode") 2>&1 | tee "...""
    // The nested double quotes break the shell parsing!

    execSync(cmdStr, { stdio: 'inherit' });
    await sleep(500);

    if (fs.existsSync(logFile4)) {
      console.log(
        `  Log content: "${fs.readFileSync(logFile4, 'utf8').trim()}"`
      );
      console.log(`  Result: SUCCESS ✓`);
      fs.unlinkSync(logFile4);
    } else {
      console.log(`  Result: FAILED - No log file ✗`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 5: Proper escaping
  console.log('Test 5: With proper quote escaping');
  const sessionName5 = `debug5-${Date.now()}`;
  const logFile5 = path.join(os.tmpdir(), `debug5-${sessionName5}.log`);

  try {
    const command = 'echo "hello from attached mode"';
    // Escape the inner quotes
    const escapedCommand = command.replace(/"/g, '\\"');
    const effectiveCommand = `(${escapedCommand}) 2>&1 | tee "${logFile5}"`;
    console.log(`  effectiveCommand: ${effectiveCommand}`);

    const screenArgs = [
      '-dmS',
      sessionName5,
      '/bin/sh',
      '-c',
      effectiveCommand,
    ];
    const cmdStr = `screen ${screenArgs.map((a) => `"${a}"`).join(' ')}`;
    console.log(`  Full command: ${cmdStr}`);

    execSync(cmdStr, { stdio: 'inherit' });
    await sleep(500);

    if (fs.existsSync(logFile5)) {
      console.log(
        `  Log content: "${fs.readFileSync(logFile5, 'utf8').trim()}"`
      );
      console.log(`  Result: SUCCESS ✓`);
      fs.unlinkSync(logFile5);
    } else {
      console.log(`  Result: FAILED - No log file ✗`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  // Test 6: Use spawnSync instead of execSync with constructed string
  console.log('Test 6: Using spawnSync with array (better approach)');
  const sessionName6 = `debug6-${Date.now()}`;
  const logFile6 = path.join(os.tmpdir(), `debug6-${sessionName6}.log`);

  try {
    const command = 'echo "hello from attached mode"';
    const effectiveCommand = `(${command}) 2>&1 | tee "${logFile6}"`;
    console.log(`  effectiveCommand: ${effectiveCommand}`);

    const { spawnSync } = require('child_process');
    const screenArgs = [
      '-dmS',
      sessionName6,
      '/bin/sh',
      '-c',
      effectiveCommand,
    ];
    console.log(`  spawnSync args: screen ${screenArgs.join(' ')}`);

    const result = spawnSync('screen', screenArgs, { stdio: 'inherit' });
    console.log(`  spawnSync exit code: ${result.status}`);

    await sleep(500);

    if (fs.existsSync(logFile6)) {
      console.log(
        `  Log content: "${fs.readFileSync(logFile6, 'utf8').trim()}"`
      );
      console.log(`  Result: SUCCESS ✓`);
      fs.unlinkSync(logFile6);
    } else {
      console.log(`  Result: FAILED - No log file ✗`);
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log('');

  console.log('=== Debug Tests Complete ===');
}

testDebug();
