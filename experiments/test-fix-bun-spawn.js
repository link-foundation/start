#!/usr/bin/env bun

/**
 * Test fix for Issue #57: Use Bun.spawn instead of node:child_process
 *
 * This approach uses Bun's native spawn API which properly handles
 * the event loop and stream completion on all platforms.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

console.log('=== Test Fix: Bun.spawn for Direct Execution ===');
console.log(`Platform: ${process.platform}`);
console.log(`Bun version: ${Bun.version}`);
console.log('');

async function runDirect(cmd) {
  const shell = process.env.SHELL || '/bin/sh';
  const shellArgs = ['-c', cmd];

  const logDir = os.tmpdir();
  const logFilename = `start-command-test-${Date.now()}.log`;
  const logFilePath = path.join(logDir, logFilename);

  const startTime = new Date().toISOString();
  const startTimeMs = Date.now();

  // Print start block
  console.log('╭──────────────────────────────────────────────────────────╮');
  console.log(`│ Starting at ${startTime}                       │`);
  console.log(`│ Command: ${cmd.padEnd(50)}│`);
  console.log('╰──────────────────────────────────────────────────────────╯');
  console.log('');

  // Use Bun.spawn instead of node:child_process
  const proc = Bun.spawn([shell, ...shellArgs], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'inherit',
  });

  // Read stdout in real-time by consuming the stream
  let stdoutContent = '';
  const stdoutReader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  // Read stdout chunks and display them
  while (true) {
    const { done, value } = await stdoutReader.read();
    if (done) break;
    const text = decoder.decode(value);
    process.stdout.write(text);
    stdoutContent += text;
  }

  // Read any stderr
  let stderrContent = '';
  const stderrReader = proc.stderr.getReader();
  while (true) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    const text = decoder.decode(value);
    process.stderr.write(text);
    stderrContent += text;
  }

  // Wait for process to exit
  const exitCode = await proc.exited;

  const endTime = new Date().toISOString();
  const durationMs = Date.now() - startTimeMs;

  // Write log file
  let logContent = `=== Start Command Log ===
Timestamp: ${startTime}
Command: ${cmd}
Shell: ${shell}
Platform: ${process.platform}
==================================================

${stdoutContent}${stderrContent}
==================================================
Finished: ${endTime}
Exit Code: ${exitCode}
`;
  fs.writeFileSync(logFilePath, logContent, 'utf8');

  // Print finish block
  console.log('');
  console.log('╭──────────────────────────────────────────────────────────╮');
  console.log(`│ Finished at ${endTime}                      │`);
  console.log(`│ Exit code: ${exitCode}                                            │`);
  console.log(`│ Duration: ${(durationMs / 1000).toFixed(3)} seconds                              │`);
  console.log(`│ Log: ${logFilePath.substring(0, 50).padEnd(50)}│`);
  console.log('╰──────────────────────────────────────────────────────────╯');

  return exitCode;
}

// Test with echo
const exitCode = await runDirect("echo 'hi'");
console.log('');
console.log(`Test completed with exit code: ${exitCode}`);
process.exit(exitCode);
