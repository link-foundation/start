#!/usr/bin/env node

const { spawn } = require('child_process');
const process = require('process');

// Get all arguments passed after the command
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Usage: $ <command> [args...]');
  console.log('Example: $ echo "Hello World"');
  process.exit(0);
}

// Join all arguments to form the complete command
const command = args.join(' ');

// Determine the shell based on the platform
const isWindows = process.platform === 'win32';
const shell = isWindows ? 'powershell.exe' : process.env.SHELL || '/bin/sh';
const shellArgs = isWindows ? ['-Command', command] : ['-c', command];

// Execute the command
const child = spawn(shell, shellArgs, {
  stdio: 'inherit',
  shell: false
});

// Handle process exit
child.on('exit', (code) => {
  process.exit(code || 0);
});

// Handle errors
child.on('error', (err) => {
  console.error('Error executing command:', err.message);
  process.exit(1);
});
