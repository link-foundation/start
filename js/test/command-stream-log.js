/**
 * Issue #253: command-stream 2.x returns completed `stdout` and `stderr` as
 * readable stream snapshots instead of strings. `--use-command-stream` must
 * still write the command's output to its log file.
 */
const { describe, it, expect } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '../src/bin/cli.js');

describe('--use-command-stream log (#253)', () => {
  it.skipIf(process.platform === 'win32')(
    'writes stdout and stderr to the log file',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-253-'));
      try {
        const result = spawnSync(
          process.execPath,
          [
            CLI,
            '--use-command-stream',
            '--',
            'sh',
            '-c',
            'echo out-253; echo err-253 >&2',
          ],
          {
            env: {
              ...process.env,
              START_APP_FOLDER: path.join(root, 'app'),
              START_LOG_DIR: path.join(root, 'logs'),
              START_DISABLE_AUTO_ISSUE: '1',
              START_DISABLE_LOG_UPLOAD: '1',
            },
            encoding: 'utf8',
            timeout: 30000,
          }
        );
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('Could not append log file');
        const logDir = path.join(root, 'logs', 'direct');
        const [logName] = fs.readdirSync(logDir);
        const log = fs.readFileSync(path.join(logDir, logName), 'utf8');
        expect(log).toContain('out-253\n');
        expect(log).toContain('err-253\n');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    40000
  );
});
