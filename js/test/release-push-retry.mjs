import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'command-stream';

import {
  checked,
  classifyPushRejection,
  pushWithRetry,
} from '../../scripts/release-git.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

function clone(dir, remote, name) {
  const work = join(dir, name);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', name);
  git(work, 'config', 'user.email', `${name}@example.com`);
  return work;
}

/**
 * Two writers on one bare `main`: `other` lands first, then `ours` pushes a
 * commit made on the stale tip - what happens when the main-writer
 * concurrency group runs two release jobs back to back (#234).
 */
async function withWriters({ otherFile, ourFile, rule = false }, callback) {
  const dir = mkdtempSync(join(tmpdir(), 'release-push-'));
  const previousCwd = process.cwd();
  try {
    const remote = join(dir, 'remote.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    const seed = clone(dir, remote, 'seed');
    writeFileSync(join(seed, 'package.json'), '{"version":"0.1.0"}\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'initial');
    git(seed, 'push', '-q', 'origin', 'main');

    const ours = clone(dir, remote, 'ours');
    const other = clone(dir, remote, 'other');
    writeFileSync(join(other, otherFile), 'other writer\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'other release');
    git(other, 'push', '-q', 'origin', 'main');

    writeFileSync(join(ours, ourFile), 'our release\n');
    git(ours, 'add', '.');
    git(ours, 'commit', '-q', '-m', 'our release');

    const pushes = join(dir, 'pushes');
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      rule
        ? `#!/bin/sh\necho x >> '${pushes}'\necho "error: GH013: Repository rule violations found for refs/heads/main." >&2\nexit 1\n`
        : `#!/bin/sh\necho x >> '${pushes}'\n`
    );
    chmodSync(hook, 0o755);
    process.chdir(ours);
    return await callback({ ours, remote, pushes });
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

const noSleep = () => Promise.resolve();

describe('pushWithRetry (#234)', () => {
  it('reproduces the bug: a writer queued behind another is rejected', async () => {
    await withWriters(
      { otherFile: 'Cargo.toml', ourFile: 'package.json' },
      async () => {
        await expect(
          checked(
            $`git push origin main`.run({ capture: true, mirror: false }),
            'git push origin main'
          )
        ).rejects.toThrow('git push origin main failed with exit code 1');
      }
    );
  });

  it('rebases onto the writer that landed first and pushes', async () => {
    await withWriters(
      { otherFile: 'Cargo.toml', ourFile: 'package.json' },
      async ({ ours, remote }) => {
        expect(await pushWithRetry($, { sleep: noSleep })).toEqual({
          attempt: 2,
        });
        expect(git(remote, 'log', '--format=%s', 'main')).toBe(
          'our release\nother release\ninitial'
        );
        expect(git(ours, 'status', '--porcelain')).toBe('');
      }
    );
  });

  it('fails loudly when the other writer changed the same files', async () => {
    await withWriters(
      { otherFile: 'package.json', ourFile: 'package.json' },
      async ({ remote }) => {
        await expect(pushWithRetry($, { sleep: noSleep })).rejects.toThrow(
          'git pull --rebase origin main'
        );
        expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe(
          'other release'
        );
      }
    );
  });

  it('does not retry a push a repository rule rejected', async () => {
    await withWriters(
      { otherFile: 'Cargo.toml', ourFile: 'package.json', rule: true },
      async ({ pushes }) => {
        // Land on the tip first so only the rule can reject the push.
        await checked(
          $`git pull --rebase origin main`.run({
            capture: true,
            mirror: false,
          }),
          'git pull --rebase'
        );
        await expect(pushWithRetry($, { sleep: noSleep })).rejects.toThrow(
          'blocked by a repository rule'
        );
        expect(existsSync(pushes)).toBe(true);
        expect(execFileSync('wc', ['-l', pushes]).toString()).toMatch(/^\s*1 /);
      }
    );
  });

  it('classifies real git push output', () => {
    expect(
      classifyPushRejection(
        ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs'
      )
    ).toBe('non-fast-forward');
    expect(
      classifyPushRejection(
        ' ! [rejected]        main -> main (non-fast-forward)'
      )
    ).toBe('non-fast-forward');
    expect(
      classifyPushRejection(
        'remote: error: GH013: Repository rule violations found for refs/heads/main.\n ! [remote rejected] main -> main (push declined due to repository rule violations)'
      )
    ).toBe('rule');
    expect(
      classifyPushRejection(
        'remote: error: GH006: Protected branch update failed for refs/heads/main.'
      )
    ).toBe('rule');
    expect(
      classifyPushRejection(
        "fatal: unable to access 'https://github.com/x/y/': Could not resolve host"
      )
    ).toBe('other');
  });
});
