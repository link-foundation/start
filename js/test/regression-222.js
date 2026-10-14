const { describe, it, expect } = require('bun:test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '../src/bin/cli.js');

// Run the CLI with the read ends of the given output pipes closed before it
// starts writing, like `$ --version | head -1` once `head` has exited.
function runWithClosedPipes(args, closed) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        START_APP_FOLDER: fs.mkdtempSync(path.join(os.tmpdir(), 'start-222-')),
        START_DISABLE_AUTO_ISSUE: '1',
        START_DISABLE_LOG_UPLOAD: '1',
      },
    });
    let stderr = '';
    for (const name of ['stdout', 'stderr']) {
      if (closed.includes(name)) {
        child[name].destroy();
      } else {
        child[name].on('data', (chunk) => (stderr += chunk));
      }
    }
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('closed output pipes (#222)', () => {
  if (process.platform === 'win32') {
    return;
  }
  const big = 'seq 1 200000';
  for (const args of [['--version'], ['-v'], ['--help']]) {
    it(`${args[0]} exits 0 when stdout is closed`, async () => {
      const result = await runWithClosedPipes(args, ['stdout']);
      expect(result.stderr).not.toContain('EPIPE');
      expect(result.code).toBe(0);
    }, 15000);
  }
  it('a command keeps its exit code when stdout is closed', async () => {
    const result = await runWithClosedPipes(
      ['--', 'sh', '-c', `${big}; exit 3`],
      ['stdout']
    );
    expect(result.stderr).not.toContain('EPIPE');
    expect(result.code).toBe(3);
  }, 15000);
  it('a command keeps its exit code when stdout and stderr are closed', async () => {
    const result = await runWithClosedPipes(
      ['--', 'sh', '-c', `${big}; ${big} >&2; exit 3`],
      ['stdout', 'stderr']
    );
    expect(result.code).toBe(3);
  }, 15000);
});
