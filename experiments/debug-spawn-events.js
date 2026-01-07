#!/usr/bin/env bun

/**
 * Debug script to understand spawn event ordering on different platforms
 * This helps diagnose Issue #57 - why echo 'hi' doesn't show output on macOS
 */

const { spawn } = require('child_process');
const os = require('os');

console.log('=== Debug Spawn Events ===');
console.log(`Platform: ${process.platform}`);
console.log(`Architecture: ${os.arch()}`);
console.log(`Bun version: ${typeof Bun !== 'undefined' ? Bun.version : 'N/A'}`);
console.log(`Node version: ${process.version}`);
console.log('');

const shell = process.env.SHELL || '/bin/sh';
const cmd = "echo 'hi'";
const shellArgs = ['-c', cmd];

console.log(`Shell: ${shell}`);
console.log(`Command: ${cmd}`);
console.log('');
console.log('--- Events Timeline ---');

const startTime = Date.now();

function logEvent(name, details = '') {
  const elapsed = Date.now() - startTime;
  console.log(`[${elapsed.toString().padStart(4)}ms] ${name}${details ? ': ' + details : ''}`);
}

logEvent('spawn', 'starting child process');

const child = spawn(shell, shellArgs, {
  stdio: ['inherit', 'pipe', 'pipe'],
});

logEvent('spawn', `PID=${child.pid}`);

// Track all events
child.stdout.on('data', (data) => {
  logEvent('stdout.data', JSON.stringify(data.toString()));
});

child.stdout.on('end', () => {
  logEvent('stdout.end');
});

child.stdout.on('close', () => {
  logEvent('stdout.close');
});

child.stderr.on('data', (data) => {
  logEvent('stderr.data', JSON.stringify(data.toString()));
});

child.stderr.on('end', () => {
  logEvent('stderr.end');
});

child.stderr.on('close', () => {
  logEvent('stderr.close');
});

child.on('spawn', () => {
  logEvent('child.spawn');
});

child.on('exit', (code, signal) => {
  logEvent('child.exit', `code=${code}, signal=${signal}`);
});

child.on('close', (code, signal) => {
  logEvent('child.close', `code=${code}, signal=${signal}`);
  console.log('');
  console.log('--- Summary ---');
  console.log(`Total time: ${Date.now() - startTime}ms`);
  console.log('All events received. Exiting.');
});

child.on('error', (err) => {
  logEvent('child.error', err.message);
});

// Safety timeout
setTimeout(() => {
  console.log('');
  console.log('[TIMEOUT] Did not receive close event within 5 seconds');
  process.exit(1);
}, 5000);
