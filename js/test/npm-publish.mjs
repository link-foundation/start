import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { $ } from 'command-stream';

import {
  isNpmVersionPublished,
  publishToNpm,
} from '../../scripts/npm-publish.mjs';

const NAME = 'start-command';
const VERSION = '9.9.9';
const noSleep = async () => {};

let dir;
let $npm;

/**
 * Put fixtures/fake-npm.sh first on PATH as `npm`. The env goes to `$`
 * explicitly: Bun hands spawned children its startup environment, not
 * later `process.env` writes.
 */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'npm-publish-'));
  copyFileSync(
    join(import.meta.dir, 'fixtures', 'fake-npm.sh'),
    join(dir, 'npm')
  );
  $npm = $({
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      FAKE_NPM_STATE: dir,
      FAKE_NPM_VERSION: VERSION,
    },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mode(value) {
  writeFileSync(join(dir, 'mode'), value);
}

function publishCalls() {
  return readFileSync(join(dir, 'calls'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('run changeset:publish')).length;
}

const options = { name: NAME, version: VERSION, sleep: noSleep };

describe.skipIf(process.platform === 'win32')('npm-publish', () => {
  it('fails when every publish attempt exits non-zero (issue #234)', async () => {
    // command-stream resolves on a non-zero exit; the old try/catch loop
    // reported "✅ Published" and set published=true here.
    mode('fail');
    await expect(publishToNpm($npm, options)).rejects.toThrow(
      `Failed to publish ${NAME}@${VERSION} after 3 attempts`
    );
    expect(publishCalls()).toBe(3);
  });

  it('fails when publish exits 0 but the registry never shows the version', async () => {
    mode('exit-0-without-publishing');
    await expect(
      publishToNpm($npm, { ...options, verifyAttempts: 2 })
    ).rejects.toThrow('exited 0 but start-command@9.9.9 is not on npm');
  });

  it('publishes and confirms the version on the registry', async () => {
    mode('succeed');
    expect(await publishToNpm($npm, options)).toEqual({
      alreadyPublished: false,
    });
    expect(existsSync(join(dir, 'published'))).toBe(true);
  });

  it('retries a failed attempt', async () => {
    mode('fail-once');
    expect(await publishToNpm($npm, options)).toEqual({
      alreadyPublished: false,
    });
    expect(publishCalls()).toBe(2);
  });

  it('accepts an attempt that failed client-side after the version landed', async () => {
    mode('fail-after-landing');
    expect(await publishToNpm($npm, options)).toEqual({
      alreadyPublished: false,
    });
    expect(publishCalls()).toBe(1);
  });

  it('skips publishing a version that is already on npm', async () => {
    writeFileSync(join(dir, 'published'), `${VERSION}\n`);
    expect(await publishToNpm($npm, options)).toEqual({
      alreadyPublished: true,
    });
    expect(existsSync(join(dir, 'mode'))).toBe(false);
  });

  it('treats only E404 as "not published" and fails closed otherwise', async () => {
    expect(await isNpmVersionPublished($npm, NAME, VERSION)).toBe(false);
    writeFileSync(join(dir, 'outage'), '');
    await expect(isNpmVersionPublished($npm, NAME, VERSION)).rejects.toThrow(
      'ECONNRESET'
    );
  });
});
