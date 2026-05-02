import { describe, expect, it } from 'bun:test';
import {
  encodeShieldsStaticBadgeSegment,
  extractChangelogEntry,
  normalizeReleaseVersionForBadge,
  packageVersionBadge,
  releaseName,
  releaseTag,
} from '../../scripts/release-name.mjs';

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

describe('release badge helpers', () => {
  it('strips plain and language-prefixed v tags before building badge versions', () => {
    expect(normalizeReleaseVersionForBadge('v1.2.3')).toBe('1.2.3');
    expect(normalizeReleaseVersionForBadge('js-v1.2.3')).toBe('1.2.3');
    expect(normalizeReleaseVersionForBadge('rust-v0.14.1')).toBe('0.14.1');
  });

  it('escapes shields.io static badge path delimiters in prerelease versions', () => {
    expect(encodeShieldsStaticBadgeSegment('1.0.0-alpha_1')).toBe(
      '1.0.0--alpha__1'
    );
  });

  it('builds an exact npm version badge without leaking the js tag prefix', () => {
    const badge = packageVersionBadge({
      packageType: 'npm',
      packageName: 'start-command',
      releaseVersion: 'js-v1.2.3',
    });

    expect(badge).toContain('/badge/npm-1.2.3-blue.svg');
    expect(badge).not.toContain('/badge/npm-js-v1.2.3-blue.svg');
    expect(badge).toContain('/start-command/v/1.2.3');
  });

  it('builds an exact crates.io version badge without leaking the rust tag prefix', () => {
    const badge = packageVersionBadge({
      packageType: 'crates',
      packageName: 'start-command',
      releaseVersion: 'rust-v0.14.1',
    });

    expect(badge).toContain('/badge/crates.io-0.14.1-orange.svg');
    expect(badge).not.toContain('/badge/crates.io-rust-v0.14.1-orange.svg');
    expect(badge).toContain('/crates/start-command/0.14.1');
  });
});

describe('extractChangelogEntry', () => {
  it('extracts a Changesets-style JavaScript entry', () => {
    const changelog = `# start-command

## 1.2.3

### Patch Changes

- Fix release badges.

## 1.2.2

- Previous change.
`;

    expect(extractChangelogEntry(changelog, 'js-v1.2.3')).toBe(
      '### Patch Changes\n\n- Fix release badges.'
    );
  });

  it('extracts a Keep-a-Changelog-style Rust entry', () => {
    const changelog = `# Changelog

## [0.14.1] - 2026-05-02

- Fix Rust release automation.

## [0.14.0] - 2026-04-24

- Previous change.
`;

    expect(extractChangelogEntry(changelog, 'rust-v0.14.1')).toBe(
      '- Fix Rust release automation.'
    );
  });
});
