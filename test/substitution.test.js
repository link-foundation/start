#!/usr/bin/env bun
/**
 * Unit tests for the substitution engine
 * Tests pattern matching, variable substitution, and rule precedence
 */

const assert = require('assert');
const {
  parseLinoContent,
  matchAndSubstitute,
  loadDefaultSubstitutions,
  processCommand,
} = require('../src/lib/substitution');

// Test data
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

// Test suite
function runTests() {
  console.log('=== Substitution Engine Unit Tests ===\n');

  let passed = 0;
  let failed = 0;
  const failures = [];

  // Load default substitutions
  const rules = loadDefaultSubstitutions();
  console.log(`✓ Loaded ${rules.length} substitution rules\n`);

  // Test: Loading substitutions
  assert(rules.length > 0, 'Should load at least one substitution rule');
  assert(Array.isArray(rules), 'Rules should be an array');
  console.log('✓ Test: loadDefaultSubstitutions() returns array of rules');

  // Test: Rule structure
  const firstRule = rules[0];
  assert(firstRule.pattern, 'Rule should have pattern property');
  assert(firstRule.replacement, 'Rule should have replacement property');
  assert(firstRule.regex, 'Rule should have regex property');
  console.log(
    '✓ Test: Rules have correct structure (pattern, replacement, regex)'
  );

  // Test: Pattern matching and substitution
  console.log('\n=== Pattern Matching Tests ===\n');
  for (const test of testCases) {
    const result = matchAndSubstitute(test.input, rules);

    if (result.command === test.expected) {
      console.log(`✓ PASS: ${test.description}`);
      console.log(`  Input:  "${test.input}"`);
      console.log(`  Output: "${result.command}"`);
      passed++;
    } else {
      console.log(`✗ FAIL: ${test.description}`);
      console.log(`  Input:    "${test.input}"`);
      console.log(`  Expected: "${test.expected}"`);
      console.log(`  Got:      "${result.command}"`);
      failed++;
      failures.push({
        test,
        actual: result.command,
      });
    }
    console.log('');
  }

  // Test: Pattern specificity (more specific patterns should match first)
  console.log('=== Pattern Specificity Tests ===\n');
  const specificityTest = matchAndSubstitute(
    'install 1.0.0 version of express npm package globally',
    rules
  );
  assert(
    specificityTest.command === 'npm install -g express@1.0.0',
    'Most specific pattern should match (with version and globally)'
  );
  console.log('✓ Test: Pattern specificity works correctly');
  console.log(
    `  Input:  "install 1.0.0 version of express npm package globally"`
  );
  console.log(`  Output: "${specificityTest.command}"\n`);

  // Test: Variable extraction
  console.log('=== Variable Extraction Tests ===\n');
  const varTest = matchAndSubstitute('install my-package npm package', rules);
  assert(
    varTest.matched && varTest.command === 'npm install my-package',
    'Should extract and substitute packageName variable'
  );
  assert(
    varTest.rule.variables.includes('packageName'),
    'Rule should have packageName in variables list'
  );
  console.log('✓ Test: Variable extraction and substitution works correctly');
  console.log(`  Pattern matched: "${varTest.rule.pattern}"`);
  console.log(`  Variables in pattern: [${varTest.rule.variables.join(', ')}]`);
  console.log(`  Result command: "${varTest.command}"\n`);

  // Test: processCommand function
  console.log('=== processCommand Integration Tests ===\n');
  const processedResult = processCommand('list files');
  assert(
    processedResult.command === 'ls -la',
    'processCommand should apply substitutions'
  );
  assert(
    processedResult.matched === true,
    'processCommand should indicate match'
  );
  console.log('✓ Test: processCommand applies substitutions');
  console.log(`  Input:  "list files"`);
  console.log(`  Output: "${processedResult.command}"`);
  console.log(`  Matched: ${processedResult.matched}\n`);

  // Test with non-matching command
  const nonMatchResult = processCommand('echo test');
  assert(
    nonMatchResult.command === 'echo test',
    'processCommand should pass through non-matching commands'
  );
  assert(
    nonMatchResult.matched === false,
    'processCommand should indicate no match'
  );
  console.log('✓ Test: processCommand passes through non-matching commands');
  console.log(`  Input:  "echo test"`);
  console.log(`  Output: "${nonMatchResult.command}"`);
  console.log(`  Matched: ${nonMatchResult.matched}\n`);

  // Summary
  console.log('=== Test Summary ===');
  console.log(`Pattern Matching: ${passed}/${testCases.length} tests passed`);
  console.log(`Total Tests: ${passed + 7}/${testCases.length + 7} passed`);

  if (failed > 0) {
    console.log(`\nFailed tests: ${failed}`);
    failures.forEach(({ test, actual }) => {
      console.log(`  - ${test.description}`);
      console.log(`    Expected: "${test.expected}"`);
      console.log(`    Got:      "${actual}"`);
    });
    process.exit(1);
  }

  console.log('\n✓ All tests passed!\n');
  process.exit(0);
}

// Run tests
runTests();
