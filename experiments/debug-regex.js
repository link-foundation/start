#!/usr/bin/env node
/**
 * Debug script to understand regex generation
 */

const { createRule, parseLinoContent } = require('../lib/substitution');

// Test creating a simple rule
const rule = createRule('install $packageName npm package', 'npm install $packageName');

console.log('Pattern:', 'install $packageName npm package');
console.log('Replacement:', 'npm install $packageName');
console.log('Generated Regex:', rule.regex);
console.log('Variables:', rule.variables);
console.log('');

// Test matching
const input = 'install gh-upload-log npm package';
const match = input.match(rule.regex);
console.log('Input:', input);
console.log('Match result:', match);

if (match) {
  console.log('Groups:', match.groups);
}

// Test simpler lino content
const simpleContent = `
(install $packageName npm package)
(npm install $packageName)
`;

const rules = parseLinoContent(simpleContent);
console.log('\nParsed rules:', JSON.stringify(rules, (key, value) => {
  if (key === 'regex') return value.toString();
  return value;
}, 2));
