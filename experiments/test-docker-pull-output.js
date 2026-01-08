#!/usr/bin/env node
/**
 * Test script to verify docker pull output format
 * This test verifies that there is no empty line between
 * the timeline marker and the virtual command line
 */

const {
  createVirtualCommandBlock,
  createVirtualCommandResult,
  createTimelineSeparator,
} = require('../js/src/lib/output-blocks');

console.log('Testing virtual command output format...\n');

// Simulate what dockerPullImage does
const image = 'alpine:latest';

// Print the virtual command line (should NOT have empty line after)
const commandBlock = createVirtualCommandBlock(`docker pull ${image}`);
console.log(commandBlock);

// Expected: next line should be docker pull output, NOT an empty line
console.log('latest: Pulling from library/alpine');
console.log('f6b4fb944634: Pull complete');
console.log('Digest: sha256:865b95f46d98cf867a156fe4a135ad3fe50d2056aa3f25ed31662dff6da4eb62');
console.log('Status: Downloaded newer image for alpine:latest');
console.log('docker.io/library/alpine:latest');

// Print result marker and separator
console.log();
console.log(createVirtualCommandResult(true));
console.log(createTimelineSeparator());

console.log('\n✓ Test complete - verify no empty line after "$ docker pull alpine:latest"');
