#!/usr/bin/env node
// Experiment: trace what happens when running bash in docker after fix

const { isInteractiveShellCommand, detectShellInEnvironment } = require('../js/src/lib/isolation');

console.log('Testing isInteractiveShellCommand:');
console.log('  bash:', isInteractiveShellCommand('bash'));
console.log('  /bin/bash:', isInteractiveShellCommand('/bin/bash'));
console.log('  bash -l:', isInteractiveShellCommand('bash -l'));
console.log('  bash -i:', isInteractiveShellCommand('bash -i'));

// What happens with the docker command construction
function simulateDockerAttachedCommand(command, shellToUse) {
  const path = require('path');
  const shellName = shellToUse.split('/').pop();
  const shellInteractiveFlag = (shellName === 'bash' || shellName === 'zsh') ? '-i' : null;
  
  const shellCmdArgs = shellInteractiveFlag ? [shellToUse, shellInteractiveFlag] : [shellToUse];
  const attachedCmdArgs = isInteractiveShellCommand(command)
    ? command.trim().split(/\s+/)
    : [...shellCmdArgs, '-c', command];
  
  const dockerArgs = ['run', '-it', '--rm', '--name', 'test-container', 'image:tag', ...attachedCmdArgs];
  return 'docker ' + dockerArgs.join(' ');
}

console.log('\nSimulated docker commands:');
console.log('  command=bash, shellToUse=/bin/bash:', simulateDockerAttachedCommand('bash', '/bin/bash'));
console.log('  command=bash, shellToUse=bash:', simulateDockerAttachedCommand('bash', 'bash'));
console.log('  command=bash -l, shellToUse=/bin/bash:', simulateDockerAttachedCommand('bash -l', '/bin/bash'));
console.log('  command=bash -i, shellToUse=/bin/bash:', simulateDockerAttachedCommand('bash -i', '/bin/bash'));
console.log('  command=echo hello, shellToUse=/bin/bash:', simulateDockerAttachedCommand('echo hello', '/bin/bash'));

console.log('\nOld behavior (before fix):');
function simulateOldDockerCommand(command, shellToUse) {
  const shellName = shellToUse.split('/').pop();
  const shellInteractiveFlag = (shellName === 'bash' || shellName === 'zsh') ? '-i' : null;
  const shellCmdArgs = shellInteractiveFlag ? [shellToUse, shellInteractiveFlag] : [shellToUse];
  const dockerArgs = ['run', '-it', '--rm', '--name', 'test-container', 'image:tag', ...shellCmdArgs, '-c', command];
  return 'docker ' + dockerArgs.join(' ');
}
console.log('  command=bash, shellToUse=/bin/bash:', simulateOldDockerCommand('bash', '/bin/bash'));
console.log('  command=echo hello, shellToUse=/bin/bash:', simulateOldDockerCommand('echo hello', '/bin/bash'));
