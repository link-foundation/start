import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { $ } from 'command-stream';

import {
  bumpVersion,
  checked,
  isCrateVersionPublished,
  nextUnpublishedVersion,
  verifyCommitOnRemote,
} from '../../scripts/release-git.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
}

/**
 * A clone of a bare `main` remote. With `reject`, the remote's pre-receive
 * hook declines every push, the way ruleset 24848039 declined the
 * GITHUB_TOKEN push of the Rust Auto Release job (#211).
 */
async function withRepo({ reject }, callback) {
  const dir = mkdtempSync(join(tmpdir(), 'release-git-'));
  const previousCwd = process.cwd();
  try {
    const remote = join(dir, 'remote.git');
    const work = join(dir, 'work');
    git(dir, 'init', '--bare', '-b', 'main', remote);
    git(dir, 'clone', remote, work);
    git(work, 'config', 'user.name', 'test');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'commit', '--allow-empty', '-m', 'initial');
    git(work, 'push', 'origin', 'main');
    if (reject) {
      const hook = join(remote, 'hooks', 'pre-receive');
      writeFileSync(
        hook,
        '#!/bin/sh\necho "error: GH013: Repository rule violations found for refs/heads/main." >&2\nexit 1\n'
      );
      chmodSync(hook, 0o755);
    }
    git(work, 'commit', '--allow-empty', '-m', 'rust-v0.25.0');
    process.chdir(work);
    return await callback(work);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withCratesServer(publishedVersions, callback) {
  const server = createServer((request, response) => {
    const version = request.url.split('/').pop();
    if (version === 'broken') {
      response.writeHead(503);
    } else {
      response.writeHead(publishedVersions.includes(version) ? 200 : 404);
    }
    response.end('{}');
  });
  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen)
  );
  const previous = process.env.CRATES_IO_BASE_URL;
  process.env.CRATES_IO_BASE_URL = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.CRATES_IO_BASE_URL;
    } else {
      process.env.CRATES_IO_BASE_URL = previous;
    }
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

const quiet = { capture: true, mirror: false };

describe('release-git (#211)', () => {
  it('reproduces the bug: command-stream resolves on a rejected push', async () => {
    await withRepo({ reject: true }, async () => {
      const result = await $`git push origin main`.run(quiet);
      expect(result.code).not.toBe(0);
      // command-stream 2.x returns stderr as a readable snapshot (#253).
      expect(String(result.stderr)).toContain('GH013');
    });
  });

  it('checked() throws when the push is rejected', async () => {
    await withRepo({ reject: true }, async () => {
      await expect(
        checked($`git push origin main`.run(quiet), 'git push origin main')
      ).rejects.toThrow('git push origin main failed with exit code 1');
    });
  });

  it('verifyCommitOnRemote() fails when the commit never reached main', async () => {
    await withRepo({ reject: true }, async () => {
      await $`git push origin main`.run(quiet);
      await expect(verifyCommitOnRemote($)).rejects.toThrow(
        'did not reach main'
      );
    });
  });

  it('verifyCommitOnRemote() accepts a pushed commit, even after main moves on', async () => {
    await withRepo({ reject: false }, async (work) => {
      await checked($`git push origin main`.run(quiet), 'git push origin main');
      const pushed = git(work, 'rev-parse', 'HEAD');
      // Another writer lands a commit on main right after our push.
      git(work, 'commit', '--allow-empty', '-m', 'later');
      git(work, 'push', 'origin', 'main');
      git(work, 'reset', '--hard', pushed);
      expect(await verifyCommitOnRemote($)).toBe(pushed);
    });
  });

  it('bumpVersion() follows semver', () => {
    expect(bumpVersion('0.23.0', 'minor')).toBe('0.24.0');
    expect(bumpVersion('0.23.4', 'patch')).toBe('0.23.5');
    expect(bumpVersion('0.23.4', 'major')).toBe('1.0.0');
  });

  it('skips 0.24.0, which crates.io had from an older tree, and picks 0.25.0', async () => {
    await withCratesServer(['0.23.0', '0.24.0'], async () => {
      const version = await nextUnpublishedVersion('0.23.0', 'minor', (v) =>
        isCrateVersionPublished('start-command', v)
      );
      expect(version).toBe('0.25.0');
    });
  });

  it('keeps the plain bump when the next version is free', async () => {
    await withCratesServer(['0.23.0'], async () => {
      const version = await nextUnpublishedVersion('0.23.0', 'patch', (v) =>
        isCrateVersionPublished('start-command', v)
      );
      expect(version).toBe('0.23.1');
    });
  });

  it('fails closed when crates.io answers neither 200 nor 404', async () => {
    await withCratesServer([], async () => {
      await expect(
        isCrateVersionPublished('start-command', 'broken')
      ).rejects.toThrow('Unexpected crates.io response 503');
    });
  });
});
