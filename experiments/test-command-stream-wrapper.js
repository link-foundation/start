#!/usr/bin/env bun
/**
 * Experiment: Test command-stream wrapper module
 */

const {
  execCommand,
  execCommandAsync,
  commandExists,
  getCommandPath,
  getToolVersion,
} = require('../src/lib/command-stream');

(async () => {
  console.log('=== Testing command-stream wrapper ===\n');

  // Test 1: Basic sync command
  console.log('Test 1: execCommand (sync-like via promise)');
  const result1 = await execCommand('echo "Hello from wrapper"');
  console.log('stdout:', result1.stdout);
  console.log('code:', result1.code);
  console.log('');

  // Test 2: Check if command exists
  console.log('Test 2: commandExists');
  const hasScreen = await commandExists('screen');
  const hasFakeCmd = await commandExists('nonexistent-command-xyz');
  console.log('screen exists:', hasScreen);
  console.log('nonexistent-command-xyz exists:', hasFakeCmd);
  console.log('');

  // Test 3: Get command path
  console.log('Test 3: getCommandPath');
  const echoPath = await getCommandPath('echo');
  console.log('echo path:', echoPath);
  console.log('');

  // Test 4: Get tool version
  console.log('Test 4: getToolVersion');
  const screenVersion = await getToolVersion('screen', '-v', true);
  console.log('screen version:', screenVersion);
  const tmuxVersion = await getToolVersion('tmux', '-V', true);
  console.log('tmux version:', tmuxVersion);
  console.log('');

  // Test 5: Async command
  console.log('Test 5: execCommandAsync');
  const result5 = await execCommandAsync('uname -r');
  console.log('stdout:', result5.stdout);
  console.log('code:', result5.code);
  console.log('');

  console.log('=== All tests completed ===');
})();
