#!/usr/bin/env bun
// Issue #211: command-stream's `$` resolves (does not throw) when `git push`
// is rejected, so a ruleset violation used to fall through to the
// "✅ Version bump committed and pushed to main" message.
// Run: bun experiments/issue-211-rejected-push.mjs
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dir, '../js/package.json'));
const { $ } = require('command-stream');

const dir = mkdtempSync(join(tmpdir(), 'issue-211-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
try {
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '--bare', '-b', 'main', remote);
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "GH013: Repository rule violations found" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  git(dir, 'clone', remote, work);
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'x');
  process.chdir(work);
  let threw = false;
  let result;
  try {
    result = await $`git push origin main`.run({ capture: true, mirror: false });
  } catch {
    threw = true;
  }
  console.log({ threw, code: result?.code, stderr: result?.stderr?.trim() });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
