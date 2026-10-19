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
import { join } from 'node:path';

import { $ } from 'command-stream';

import {
  DEFAULT_VERIFY_ATTEMPTS,
  isAlreadyPublishedError,
  isNpmVersionPublished,
  publishToNpm,
} from '../../scripts/npm-publish.mjs';

const NAME = 'start-command';
const VERSION = '9.9.9';
const noSleep = async () => {};

let dir;
let $npm;

/**
 * Run fixtures/fake-npm.sh wherever the script under test runs `npm`. It is
 * called by absolute path, not found through PATH: command-stream runs
 * commands in a login shell (`sh -l -c`), and on macOS /etc/profile puts the
 * system directories, which hold the real npm, before ours (issue #234;
 * experiments/issue-234/login-shell-path-reorder.sh). The env goes to `$`
 * explicitly: Bun hands spawned children its startup environment, not
 * later `process.env` writes.
 */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'npm-publish-'));
  const fakeNpm = join(dir, 'npm');
  copyFileSync(join(import.meta.dir, 'fixtures', 'fake-npm.sh'), fakeNpm);
  const $env = $({
    env: {
      ...process.env,
      FAKE_NPM_STATE: dir,
      FAKE_NPM_VERSION: VERSION,
    },
  });
  $npm = (strings, ...values) =>
    $env(
      [strings[0].replace(/^npm(?= )/, `'${fakeNpm}'`), ...strings.slice(1)],
      ...values
    );
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

  // npm can take minutes to show a version it accepted; the template has
  // seen 874s. A 60-second wait failed a release that had published (#234).
  it('waits as long as npm takes to show a published version', async () => {
    mode('land-late');
    expect(await publishToNpm($npm, options)).toEqual({
      alreadyPublished: false,
    });
    expect(publishCalls()).toBe(1);
  });

  // A retry after a timed-out attempt that landed is rejected with "cannot
  // publish over the previously published versions". That is a cue to wait
  // for the registry, not a failure to retry (#234).
  it('waits instead of republishing when npm says the version exists', async () => {
    mode('time-out-while-landing');
    expect(await publishToNpm($npm, options)).toEqual({
      alreadyPublished: false,
    });
    expect(publishCalls()).toBe(2);
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

  it('reads every "npm already has this version" answer as landed', () => {
    for (const output of [
      'npm error code E403\nnpm error You cannot publish over the previously published versions: 9.9.9.',
      'npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/start-command - Cannot publish over previously staged version 9.9.9',
      'npm ERR! code EPUBLISHCONFLICT',
    ]) {
      expect(isAlreadyPublishedError(output)).toBe(true);
    }
    expect(
      isAlreadyPublishedError('npm error code E403\nnpm error 403 Forbidden')
    ).toBe(false);
  });

  // The registry wait is useless if the job is killed first (#234).
  it('gives every publishing job time to outlast the registry wait', () => {
    const workflow = readFileSync(
      join(import.meta.dir, '..', '..', '.github', 'workflows', 'js.yml'),
      'utf8'
    );
    const jobs = workflow.split(/\n(?= {2}[a-z-]+:\n)/);
    const publishers = jobs.filter((job) =>
      job.includes('scripts/publish-to-npm.mjs')
    );
    expect(publishers.length).toBe(2);
    const waitMinutes = (DEFAULT_VERIFY_ATTEMPTS * 10) / 60;
    for (const job of publishers) {
      const minutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(job)[1]);
      expect(minutes).toBeGreaterThanOrEqual(waitMinutes + 15);
    }
  });
});
