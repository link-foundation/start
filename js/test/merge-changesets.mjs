import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeChangesetsIn } from '../../scripts/merge-changesets.mjs';

function makeTempPackage(packageName) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-changesets-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: packageName, version: '0.0.0' })
  );
  mkdirSync(join(dir, '.changeset'));
  return dir;
}

function writeChangeset(dir, fileName, body) {
  writeFileSync(join(dir, '.changeset', fileName), body);
}

describe('mergeChangesetsIn', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempPackage('start-command');
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does nothing with zero changesets', () => {
    const result = mergeChangesetsIn(tmpDir);
    expect(result.merged).toBe(false);
    expect(readdirSync(join(tmpDir, '.changeset'))).toEqual([]);
  });

  it('does nothing with a single changeset', () => {
    writeChangeset(
      tmpDir,
      'lone.md',
      `---\n'start-command': patch\n---\n\nOnly one\n`
    );
    const result = mergeChangesetsIn(tmpDir);
    expect(result.merged).toBe(false);
    expect(readdirSync(join(tmpDir, '.changeset'))).toEqual(['lone.md']);
  });

  it('merges multiple changesets into a single file with the highest bump', () => {
    writeChangeset(
      tmpDir,
      'a.md',
      `---\n'start-command': patch\n---\n\nFix A\n`
    );
    writeChangeset(
      tmpDir,
      'b.md',
      `---\n'start-command': minor\n---\n\nFeature B\n`
    );

    const result = mergeChangesetsIn(tmpDir);
    expect(result.merged).toBe(true);
    expect(result.bumpType).toBe('minor');

    const files = readdirSync(join(tmpDir, '.changeset'));
    expect(files.length).toBe(1);
    const mergedFile = files[0];
    expect(mergedFile.startsWith('merged-')).toBe(true);

    const content = readFileSync(
      join(tmpDir, '.changeset', mergedFile),
      'utf8'
    );
    expect(content).toContain("'start-command': minor");
    expect(content).toContain('Fix A');
    expect(content).toContain('Feature B');
  });

  it('chooses major over minor and patch', () => {
    writeChangeset(tmpDir, 'a.md', `---\n'start-command': patch\n---\n\nFix\n`);
    writeChangeset(
      tmpDir,
      'b.md',
      `---\n'start-command': major\n---\n\nBreaking\n`
    );
    writeChangeset(
      tmpDir,
      'c.md',
      `---\n'start-command': minor\n---\n\nFeat\n`
    );

    const result = mergeChangesetsIn(tmpDir);
    expect(result.bumpType).toBe('major');
  });

  it('reads package name from package.json (no hardcoded placeholder)', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'merge-changesets-other-'));
    try {
      writeFileSync(
        join(otherDir, 'package.json'),
        JSON.stringify({ name: 'some-other-pkg', version: '1.0.0' })
      );
      mkdirSync(join(otherDir, '.changeset'));
      writeFileSync(
        join(otherDir, '.changeset', 'a.md'),
        `---\n'some-other-pkg': minor\n---\n\nA\n`
      );
      writeFileSync(
        join(otherDir, '.changeset', 'b.md'),
        `---\n'some-other-pkg': patch\n---\n\nB\n`
      );

      const result = mergeChangesetsIn(otherDir);
      expect(result.merged).toBe(true);

      const files = readdirSync(join(otherDir, '.changeset'));
      const merged = readFileSync(
        join(otherDir, '.changeset', files[0]),
        'utf8'
      );
      expect(merged).toContain("'some-other-pkg': minor");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('throws when .changeset directory is missing', () => {
    const noChangesetDir = mkdtempSync(
      join(tmpdir(), 'merge-changesets-empty-')
    );
    try {
      writeFileSync(
        join(noChangesetDir, 'package.json'),
        JSON.stringify({ name: 'x', version: '0.0.0' })
      );
      expect(() => mergeChangesetsIn(noChangesetDir)).toThrow(
        /Changeset directory not found/
      );
    } finally {
      rmSync(noChangesetDir, { recursive: true, force: true });
    }
  });
});
