import { describe, expect, it } from 'bun:test';

import {
  checkCoverage,
  parseTarpaulinCoverage,
} from '../../scripts/check-rust-coverage.mjs';

// Tail of a passing cargo-tarpaulin 0.37.5 run (Rust CI/CD, run 39256972823).
const PASSING_LOG = `|| src/lib/usage.rs: 0/1
|| src/lib/user_manager.rs: 48/170
||
73.81% coverage, 6296/8530 lines covered
`;

// Tail of the failing run on main (run 39257928573): a test failed, tarpaulin
// stopped before its summary, and the old step reported
// "Coverage % is below the 50% threshold" (issue #234).
const FAILED_TEST_LOG = `failures:
    reservation_failure_after_cleanup_preserves_restart_state

test result: FAILED. 5 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.13s

Error: "Test failed during run"
`;

describe('check-rust-coverage', () => {
  it('parses the tarpaulin summary line', () => {
    expect(parseTarpaulinCoverage(PASSING_LOG)).toBe(73.81);
  });

  it('uses the last summary when several are printed', () => {
    const log =
      '10.00% coverage, 1/10 lines covered\r\n60.5% coverage, 6/10 lines covered\r\n';
    expect(parseTarpaulinCoverage(log)).toBe(60.5);
  });

  it('ignores lines that only mention coverage', () => {
    expect(parseTarpaulinCoverage('Coverage: 73.81%\n')).toBeNull();
    expect(parseTarpaulinCoverage('')).toBeNull();
    expect(parseTarpaulinCoverage(undefined)).toBeNull();
  });

  it('passes when coverage meets the threshold', () => {
    const result = checkCoverage(PASSING_LOG, 50);
    expect(result.ok).toBe(true);
    expect(result.message).toBe('✅ Coverage 73.81% meets the 50% threshold');
  });

  it('fails when coverage is below the threshold', () => {
    const result = checkCoverage(PASSING_LOG, 80);
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      '❌ Coverage 73.81% is below the 80% threshold'
    );
  });

  it('reports a failed test instead of an empty coverage drop (issue #234)', () => {
    const result = checkCoverage(FAILED_TEST_LOG, 50);
    expect(result.ok).toBe(false);
    expect(result.coverage).toBeNull();
    expect(result.message).toContain('a test failed');
    expect(result.message).not.toContain('below the');
    expect(result.message).not.toContain('Coverage %');
  });

  it('fails when the log has no summary for another reason', () => {
    const result = checkCoverage('error: could not compile', 50);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not determine coverage');
  });
});
