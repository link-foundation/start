import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../..');
const scriptPath = resolve(repoRoot, 'scripts/create-github-release.mjs');

function createFakeGhBin(tempDir) {
  const fakeGhJs = join(tempDir, 'fake-gh.cjs');
  writeFileSync(
    fakeGhJs,
    `
const fs = require('node:fs');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_GH_PAYLOAD_PATH, input);

  if (process.env.FAKE_GH_MODE === 'already_exists') {
    console.error('gh: Validation Failed (HTTP 422)');
    console.error(JSON.stringify({
      message: 'Validation Failed',
      errors: [{ resource: 'Release', code: 'already_exists', field: 'tag_name' }],
    }));
    process.exit(1);
  }

  if (process.env.FAKE_GH_MODE === 'failure') {
    console.error('gh: server exploded');
    process.exit(1);
  }

  console.log(JSON.stringify({ html_url: 'https://github.test/release' }));
  process.exit(0);
});
`
  );

  return fakeGhJs;
}

function runScript(mode) {
  const tempDir = mkdtempSync(join(tmpdir(), 'create-release-test-'));
  const payloadPath = join(tempDir, 'payload.json');
  const changelogPath = join(tempDir, 'CHANGELOG.md');
  writeFileSync(
    changelogPath,
    '# Changelog\n\n## [1.2.3] - 2026-05-03\n\n- Release automation fix.\n'
  );
  const fakeGhJs = createFakeGhBin(tempDir);

  const result = spawnSync(
    'node',
    [
      scriptPath,
      '--release-version',
      '1.2.3',
      '--repository',
      'owner/repo',
      '--prefix',
      'rust-',
      '--changelog-file',
      changelogPath,
      '--badge-type',
      'crates',
      '--package-name',
      'start-command',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GH_MODE: mode,
        FAKE_GH_PAYLOAD_PATH: payloadPath,
        START_GH_COMMAND: process.execPath,
        START_GH_COMMAND_ARGS: JSON.stringify([fakeGhJs]),
      },
    }
  );

  const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
  rmSync(tempDir, { force: true, recursive: true });
  return { result, payload };
}

describe('create-github-release script', () => {
  it('treats an existing GitHub release as an idempotent skip', () => {
    const { result, payload } = runScript('already_exists');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'GitHub release already exists: rust-v1.2.3'
    );
    expect(result.stdout).not.toContain('Created GitHub release');
    expect(payload).toMatchObject({
      tag_name: 'rust-v1.2.3',
      name: '[Rust] 1.2.3',
    });
    expect(payload.body).toContain('Release automation fix.');
    expect(payload.body).toContain('crates.io');
  });

  it('fails when gh api returns an unexpected error', () => {
    const { result } = runScript('failure');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('server exploded');
    expect(result.stderr).toContain('GitHub release creation failed');
  });
});
