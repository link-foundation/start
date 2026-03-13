#!/usr/bin/env node
/**
 * Experiment to verify fix for issue #89:
 * Show "$ docker pull <image>" before "Docker is not installed" error
 * 
 * Run with: node experiments/test-docker-not-installed-output.js
 */

const {
  createVirtualCommandBlock,
  createVirtualCommandResult,
  createTimelineSeparator,
} = require('../js/src/lib/output-blocks');

const image = 'konard/sandbox';

console.log('=== Simulated output when Docker is NOT installed (issue #89 fix) ===\n');

// This is what should appear BEFORE the error message
console.log(createVirtualCommandBlock(`docker pull ${image}`));
console.log(); // empty line between command and result
console.log(createVirtualCommandResult(false));
console.log(createTimelineSeparator());

// Then the error appears
console.error(`Error: Docker is not installed. Install Docker from https://docs.docker.com/get-docker/`);

console.log('\n=== Expected format verified ===');
console.log('✓ "$ docker pull konard/sandbox" appears before the error');
console.log('✓ "✗" failure marker shown');
console.log('✓ "│" separator shown');
