#!/usr/bin/env node
/**
 * Test script for the substitution engine
 * Tests pattern matching with various inputs
 */

const path = require('path');

// Import the substitution module
const {
  parseLinoContent,
  matchAndSubstitute,
  loadDefaultSubstitutions,
  processCommand,
} = require('../src/lib/substitution');

const testCases = [
  // NPM install patterns
  {
    input: 'install gh-upload-log npm package',
    expected: 'npm install gh-upload-log',
    description: 'Basic npm install',
  },
  {
    input: 'install 0.0.1 version of gh-upload-log npm package',
    expected: 'npm install gh-upload-log@0.0.1',
    description: 'npm install with version',
  },
  {
    input: 'install lodash npm package globally',
    expected: 'npm install -g lodash',
    description: 'Global npm install',
  },
  {
    input: 'install 4.17.21 version of lodash npm package globally',
    expected: 'npm install -g lodash@4.17.21',
    description: 'Global npm install with version',
  },
  {
    input: 'uninstall lodash npm package',
    expected: 'npm uninstall lodash',
    description: 'npm uninstall',
  },

  // Git patterns
  {
    input: 'clone https://github.com/user/repo repository',
    expected: 'git clone https://github.com/user/repo',
    description: 'Git clone with URL',
  },
  {
    input: 'clone git@github.com:user/repo.git repository',
    expected: 'git clone git@github.com:user/repo.git',
    description: 'Git clone with SSH URL',
  },
  {
    input: 'checkout main branch',
    expected: 'git checkout main',
    description: 'Git checkout branch',
  },
  {
    input: 'create feature-x branch',
    expected: 'git checkout -b feature-x',
    description: 'Git create branch',
  },

  // Common operations
  {
    input: 'list files',
    expected: 'ls -la',
    description: 'List files',
  },
  {
    input: 'show current directory',
    expected: 'pwd',
    description: 'Show working directory',
  },
  {
    input: 'create my-project directory',
    expected: 'mkdir -p my-project',
    description: 'Create directory',
  },

  // Python patterns
  {
    input: 'install requests python package',
    expected: 'pip install requests',
    description: 'pip install',
  },

  // Non-matching patterns (should return original)
  {
    input: 'echo hello world',
    expected: 'echo hello world',
    description: 'Non-matching command (pass through)',
  },
  {
    input: 'npm test',
    expected: 'npm test',
    description: 'Regular npm command (pass through)',
  },
];

console.log('=== Substitution Engine Tests ===\n');

// Load default substitutions
const rules = loadDefaultSubstitutions();
console.log(`Loaded ${rules.length} substitution rules\n`);

let passed = 0;
let failed = 0;

for (const test of testCases) {
  const result = matchAndSubstitute(test.input, rules);

  if (result.command === test.expected) {
    console.log(`✓ PASS: ${test.description}`);
    console.log(`  Input:    "${test.input}"`);
    console.log(`  Output:   "${result.command}"`);
    console.log(
      `  Matched:  ${result.matched ? result.rule.pattern : 'none (pass through)'}`
    );
    passed++;
  } else {
    console.log(`✗ FAIL: ${test.description}`);
    console.log(`  Input:    "${test.input}"`);
    console.log(`  Expected: "${test.expected}"`);
    console.log(`  Got:      "${result.command}"`);
    console.log(`  Matched:  ${result.matched ? result.rule.pattern : 'none'}`);
    failed++;
  }
  console.log('');
}

console.log('=== Summary ===');
console.log(`Passed: ${passed}/${testCases.length}`);
console.log(`Failed: ${failed}/${testCases.length}`);

if (failed > 0) {
  process.exit(1);
}

console.log('\n=== All tests passed! ===');
