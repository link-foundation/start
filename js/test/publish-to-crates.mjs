import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../..');
const scriptPath = resolve(repoRoot, 'scripts/publish-to-crates.mjs');

function createCargoPackage(tempDir) {
  const packageDir = join(tempDir, 'crate');
  const cargoTomlPath = join(packageDir, 'Cargo.toml');
  mkdirSync(packageDir);
  writeFileSync(
    cargoTomlPath,
    '[package]\nname = "example-crate"\nversion = "1.2.3"\nedition = "2021"\n'
  );
  return packageDir;
}

function createFakeCargoBin(tempDir) {
  const fakeCargoJs = join(tempDir, 'fake-cargo.cjs');
  writeFileSync(
    fakeCargoJs,
    `
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CARGO_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.FAKE_CARGO_EXIT || 0));
`
  );

  return fakeCargoJs;
}

async function withCratesServer(status, callback) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: status === 200 }));
  });

  await new Promise((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen)
  );
  const { port } = server.address();

  try {
    return await callback(`http://127.0.0.1:${port}/api/v1`, requests);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function runScript({
  cargoToken = '',
  cratesIoBaseUrl,
  fakeCargo = false,
  packageDir,
  tempDir,
}) {
  const outputPath = join(tempDir, 'github-output.txt');
  const cargoArgsPath = join(tempDir, 'cargo-args.json');
  const fakeCargoJs = fakeCargo ? createFakeCargoBin(tempDir) : '';

  const env = {
    ...process.env,
    CARGO_REGISTRY_TOKEN: cargoToken,
    CRATES_IO_BASE_URL: cratesIoBaseUrl,
    CRATES_PUBLISH_RETRY_DELAY_MS: '1',
    FAKE_CARGO_ARGS_PATH: cargoArgsPath,
    GITHUB_OUTPUT: outputPath,
  };

  if (fakeCargoJs) {
    env.START_CARGO_COMMAND = process.execPath;
    env.START_CARGO_COMMAND_ARGS = JSON.stringify([fakeCargoJs]);
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('node', [scriptPath, '--working-dir', packageDir], {
      cwd: repoRoot,
      env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectRun);
    child.on('close', (status, signal) => {
      resolveRun({
        cargoArgsPath,
        outputPath,
        result: {
          signal,
          status,
          stderr,
          stdout,
        },
      });
    });
  });
}

describe('publish-to-crates script', () => {
  it('reports success without a token when the version is already published', async () => {
    await withCratesServer(200, async (cratesIoBaseUrl, requests) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'publish-crates-test-'));
      const packageDir = createCargoPackage(tempDir);

      try {
        const { outputPath, result } = await runScript({
          cratesIoBaseUrl,
          packageDir,
          tempDir,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('already_published=true');
        expect(readFileSync(outputPath, 'utf8')).toContain('published=true');
        expect(requests).toEqual(['/api/v1/crates/example-crate/1.2.3']);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  });

  it('fails clearly when a missing version needs a crates token', async () => {
    await withCratesServer(404, async (cratesIoBaseUrl) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'publish-crates-test-'));
      const packageDir = createCargoPackage(tempDir);

      try {
        const { result } = await runScript({
          cratesIoBaseUrl,
          packageDir,
          tempDir,
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Missing crates.io token');
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  });

  it('publishes a missing version with cargo publish', async () => {
    await withCratesServer(404, async (cratesIoBaseUrl) => {
      const tempDir = mkdtempSync(join(tmpdir(), 'publish-crates-test-'));
      const packageDir = createCargoPackage(tempDir);

      try {
        const { cargoArgsPath, outputPath, result } = await runScript({
          cargoToken: 'test-token',
          cratesIoBaseUrl,
          fakeCargo: true,
          packageDir,
          tempDir,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('publish_result=published');
        expect(readFileSync(outputPath, 'utf8')).toContain('published=true');
        expect(JSON.parse(readFileSync(cargoArgsPath, 'utf8'))).toEqual([
          'publish',
          '--allow-dirty',
          '--manifest-path',
          join(packageDir, 'Cargo.toml'),
          '--token',
          'test-token',
        ]);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    });
  });
});
