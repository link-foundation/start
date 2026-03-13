#!/usr/bin/env node
/**
 * Checks that the Rust test count is within 10% of the JavaScript test count.
 *
 * JavaScript tests: count `it(` calls in js/test/*.test.js
 * Rust tests:       count `#[test]` and `fn test_` in rust/tests/**\/*.rs and rust/src/**\/*.rs
 *
 * CI/CD fails if Rust has at least 10% fewer test cases than JavaScript.
 */

import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function countWithGrepOrFallback(pattern, path, isFile = false) {
  try {
    const flag = isFile ? '' : '-r';
    const result = execSync(`grep -c "${pattern}" ${flag} ${path} 2>/dev/null || echo 0`, {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    // When using -r, grep -c outputs file:count lines, sum them
    if (result.includes(':')) {
      return result
        .split('\n')
        .filter(Boolean)
        .reduce((sum, line) => {
          const count = parseInt(line.split(':').pop(), 10);
          return sum + (isNaN(count) ? 0 : count);
        }, 0);
    }
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

// Count JS test cases: it( calls in test files
const jsCount = countWithGrepOrFallback('it(', 'js/test');
console.log(`JavaScript test cases (it() calls): ${jsCount}`);

// Count Rust test cases: #[test] attribute in .rs files
const rustTestAttrs = countWithGrepOrFallback('#\\[test\\]', 'rust');
console.log(`Rust test cases (#[test] macros): ${rustTestAttrs}`);

if (jsCount === 0) {
  console.error('ERROR: Could not count JavaScript tests. Check js/test/ directory.');
  process.exit(1);
}

if (rustTestAttrs === 0) {
  console.error('ERROR: Could not count Rust tests. Check rust/ directory.');
  process.exit(1);
}

// Check parity: Rust should have at least 90% as many tests as JavaScript
const ratio = rustTestAttrs / jsCount;
const threshold = 0.9;

console.log(`\nTest count ratio (Rust/JS): ${(ratio * 100).toFixed(1)}%`);
console.log(`Required minimum: ${(threshold * 100).toFixed(0)}%`);

if (ratio < threshold) {
  const deficit = Math.ceil(jsCount * threshold) - rustTestAttrs;
  console.error(`\n❌ FAIL: Rust has ${(ratio * 100).toFixed(1)}% of JavaScript test count.`);
  console.error(
    `   Rust needs at least ${Math.ceil(jsCount * threshold)} tests to reach ${(threshold * 100).toFixed(0)}% of JS count (${jsCount}).`
  );
  console.error(`   Add approximately ${deficit} more Rust tests to pass this check.`);
  console.error(
    `\n   See issue #93: https://github.com/link-foundation/start/issues/93`
  );
  process.exit(1);
} else {
  console.log(`\n✅ PASS: Rust test count (${rustTestAttrs}) is within acceptable range of JS count (${jsCount}).`);
}
