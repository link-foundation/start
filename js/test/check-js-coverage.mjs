import { describe, expect, it } from 'bun:test';

import {
  checkCoverage,
  parseLineCoverage,
} from '../../scripts/check-js-coverage.mjs';

// Verbatim Bun 1.3 text reporter output: the totals row carries no `%` suffix,
// which is why the previous CI grep never matched (issue #158).
const BUN_REPORT = `bun test v1.3.14 (0d9b296a)
-----------------|---------|---------|-------------------
File             | % Funcs | % Lines | Uncovered Line #s
-----------------|---------|---------|-------------------
All files        |  100.00 |   83.33 |
 test/version.js |  100.00 |   83.33 | 38-43,103,105-108
-----------------|---------|---------|-------------------

 14 pass
 0 fail
`;

describe('check-js-coverage', () => {
  it('parses line coverage from a real Bun text report', () => {
    expect(parseLineCoverage(BUN_REPORT)).toBe(83.33);
  });

  it('reads the line column, not the function column', () => {
    const report = 'All files | 92.60 | 88.09 |';
    expect(parseLineCoverage(report)).toBe(88.09);
  });

  it('ignores the uncovered-lines column when picking numbers', () => {
    const report = 'All files |  10.00 |  20.00 | 30-40,50';
    expect(parseLineCoverage(report)).toBe(20);
  });

  it('returns null when no totals row is present', () => {
    expect(parseLineCoverage('bun test v1.3.14\n 0 pass\n')).toBeNull();
    expect(parseLineCoverage('')).toBeNull();
    expect(parseLineCoverage(undefined)).toBeNull();
  });

  it('fails instead of skipping when coverage cannot be determined', () => {
    const result = checkCoverage('no table here', 45);
    expect(result.ok).toBe(false);
    expect(result.coverage).toBeNull();
    expect(result.message).toContain('Could not determine coverage');
  });

  it('passes when coverage meets the threshold', () => {
    const result = checkCoverage(BUN_REPORT, 45);
    expect(result.ok).toBe(true);
    expect(result.coverage).toBe(83.33);
  });

  it('fails when coverage is below the threshold', () => {
    const result = checkCoverage(BUN_REPORT, 90);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('below the 90% threshold');
  });
});
