import { describe, expect, test } from 'bun:test';
import {
  applyDefaultTimeout,
  hasExplicitTimeout,
} from '../../scripts/run-js-tests.mjs';

describe('run-js-tests timeout defaults', () => {
  test('adds a 30 second timeout when no timeout is supplied', () => {
    expect(applyDefaultTimeout(['--coverage'])).toEqual([
      '--timeout',
      '30000',
      '--coverage',
    ]);
  });

  test('preserves an explicit long timeout flag', () => {
    expect(hasExplicitTimeout(['--timeout', '45000'])).toBe(true);
    expect(applyDefaultTimeout(['--timeout', '45000'])).toEqual([
      '--timeout',
      '45000',
    ]);
  });

  test('preserves an explicit inline timeout flag', () => {
    expect(hasExplicitTimeout(['--timeout=45000'])).toBe(true);
    expect(applyDefaultTimeout(['--timeout=45000'])).toEqual([
      '--timeout=45000',
    ]);
  });

  test('preserves Bun short timeout flag', () => {
    expect(hasExplicitTimeout(['-t', '45000'])).toBe(true);
    expect(applyDefaultTimeout(['-t', '45000'])).toEqual(['-t', '45000']);
  });
});
