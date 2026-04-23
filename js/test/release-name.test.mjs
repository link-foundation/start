import { describe, expect, it } from 'bun:test';
import { releaseName, releaseTag } from '../../scripts/release-name.mjs';

describe('releaseTag', () => {
  it('uses plain "v${version}" when no prefix is given', () => {
    expect(releaseTag('0.25.4')).toBe('v0.25.4');
    expect(releaseTag('0.25.4', '')).toBe('v0.25.4');
  });

  it('prepends known language prefixes', () => {
    expect(releaseTag('0.25.4', 'js-')).toBe('js-v0.25.4');
    expect(releaseTag('0.14.0', 'rust-')).toBe('rust-v0.14.0');
  });

  it('passes arbitrary prefixes through', () => {
    expect(releaseTag('1.0.0', 'api-')).toBe('api-v1.0.0');
  });
});

describe('releaseName', () => {
  it('returns bare version when prefix is empty (preserves pre-issue-108 behaviour)', () => {
    expect(releaseName('0.25.4')).toBe('0.25.4');
    expect(releaseName('0.25.4', '')).toBe('0.25.4');
  });

  it('decorates known language prefixes with human titles', () => {
    expect(releaseName('0.25.4', 'js-')).toBe('[JavaScript] 0.25.4');
    expect(releaseName('0.14.0', 'rust-')).toBe('[Rust] 0.14.0');
  });

  it('falls back to "${prefix}${version}" for unknown prefixes', () => {
    expect(releaseName('1.0.0', 'api-')).toBe('api-1.0.0');
  });
});
