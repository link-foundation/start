#!/usr/bin/env node
// Issue #211 end-to-end: run scripts/version-and-commit.mjs in Rust
// changelog mode against a local remote that rejects (or accepts) the push,
// with a fake crates.io that already has 0.23.0 and 0.24.0. Needs network
// for use-m. Run: node experiments/issue-211-version-and-commit-e2e.mjs
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../scripts/version-and-commit.mjs'
);
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

const server = createServer((req, res) => {
  const version = req.url.split('/').pop();
  res.writeHead(['0.23.0', '0.24.0'].includes(version) ? 200 : 404);
  res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// Async spawn: spawnSync would block the fake crates.io in this process.
function run(cwd, env) {
  return new Promise((done) => {
    const child = spawn(
      'node',
      [script, '--mode', 'changelog', '--working-dir', 'rust', '--bump-type', 'minor'],
      { cwd, env: { ...process.env, ...env } }
    );
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (status) => done({ status, output }));
  });
}

for (const reject of [true, false]) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-211-e2e-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(dir, 'init', '--bare', '-b', 'main', remote);
  git(dir, 'clone', remote, work);
  mkdirSync(join(work, 'rust/changelog.d'), { recursive: true });
  writeFileSync(
    join(work, 'rust/Cargo.toml'),
    '[package]\nname = "start-command"\nversion = "0.23.0"\n'
  );
  writeFileSync(
    join(work, 'rust/CHANGELOG.md'),
    '# Changelog\n\n<!-- changelog-insert-here -->\n'
  );
  writeFileSync(
    join(work, 'rust/changelog.d/204.md'),
    '---\nbump: minor\n---\n\nCPU penalty fix\n'
  );
  git(work, 'add', '-A');
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init');
  git(work, 'push', 'origin', 'main');
  if (reject) {
    const hook = join(remote, 'hooks/pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\necho "GH013: Repository rule violations found" >&2\nexit 1\n'
    );
    chmodSync(hook, 0o755);
  }
  const outputFile = join(dir, 'out.txt');
  writeFileSync(outputFile, '');
  const { status, output } = await run(work, {
    GITHUB_OUTPUT: outputFile,
    CRATES_IO_BASE_URL: `http://127.0.0.1:${server.address().port}/api/v1`,
  });
  console.log(`\n=== reject=${reject} exit=${status}`);
  console.log(
    output
      .split('\n')
      .filter((l) => /✅|Error|version|Verified|already|GH013/.test(l))
      .join('\n')
  );
  console.log(
    'GITHUB_OUTPUT:',
    readFileSync(outputFile, 'utf8').trim().replace(/\n/g, ', ')
  );
  console.log('remote main:', git(remote, 'log', '--format=%s', '-1', 'main'));
  rmSync(dir, { recursive: true, force: true });
}
server.close();
