/**
 * Integration tests for --status query functionality
 */

const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
} = require('../src/lib/execution-store');

// Use temp directory for tests
const TEST_APP_FOLDER = path.join(
  os.tmpdir(),
  `status-query-test-${Date.now()}`
);

// Path to CLI
const CLI_PATH = path.join(__dirname, '../src/bin/cli.js');

// Helper to clean up test directory
function cleanupTestDir() {
  if (fs.existsSync(TEST_APP_FOLDER)) {
    fs.rmSync(TEST_APP_FOLDER, { recursive: true, force: true });
  }
}

// Helper to run CLI command
function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      START_APP_FOLDER: TEST_APP_FOLDER,
      ...env,
    },
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

function createExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function fakeUploaderScript(fakeBin, outputPrefix) {
  const fixturePath = path.join(fakeBin, 'capture-upload.js');
  fs.writeFileSync(
    fixturePath,
    [
      "const fs = require('fs');",
      'const args = process.argv.slice(2);',
      'fs.writeFileSync(process.env.UPLOAD_CAPTURE, JSON.stringify({',
      '  args, content: fs.readFileSync(args[0], "utf8"),',
      '  mode: fs.statSync(args[0]).mode & 0o777,',
      '}));',
      `console.log(${JSON.stringify(outputPrefix)} + ': ' + args[0]);`,
      '',
    ].join('\n')
  );
  if (process.platform === 'win32') {
    return `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`;
  }
  return `#!/bin/sh\n"${process.execPath}" "${fixturePath}" "$@"\n`;
}

function createFakeUploader(fakeBin, outputPrefix) {
  const content = fakeUploaderScript(fakeBin, outputPrefix);
  if (process.platform === 'win32') {
    createExecutable(path.join(fakeBin, 'gh-upload-log.cmd'), content);
    return;
  }

  createExecutable(path.join(fakeBin, 'gh-upload-log'), content);
}

describe('--status query functionality', () => {
  let store;
  let testRecord;

  beforeEach(() => {
    cleanupTestDir();
    store = new ExecutionStore({
      appFolder: TEST_APP_FOLDER,
      useLinks: false,
    });

    // Create a test execution record
    testRecord = new ExecutionRecord({
      command: 'echo hello world',
      pid: 12345,
      logPath: '/tmp/test.log',
      workingDirectory: '/home/test',
      shell: '/bin/bash',
    });
    testRecord.complete(0);
    store.save(testRecord);
  });

  afterEach(() => {
    cleanupTestDir();
  });

  describe('links-notation format (default)', () => {
    it('should output status in links-notation indented format by default', () => {
      const result = runCli(['--status', testRecord.uuid]);

      expect(result.exitCode).toBe(0);
      // Should start with UUID on its own line
      expect(result.stdout).toMatch(new RegExp(`^${testRecord.uuid}\\n`));
      // Should have indented properties (values without special chars are not quoted)
      expect(result.stdout).toContain(`  uuid ${testRecord.uuid}`);
      expect(result.stdout).toContain('  status executed');
      // Command with space should be quoted
      expect(result.stdout).toContain('  command "echo hello world"');
    });

    it('should output status in links-notation format with explicit flag', () => {
      const result = runCli([
        '--status',
        testRecord.uuid,
        '--output-format',
        'links-notation',
      ]);

      expect(result.exitCode).toBe(0);
      // Should start with UUID on its own line
      expect(result.stdout).toMatch(new RegExp(`^${testRecord.uuid}\\n`));
      // UUID without special chars is not quoted
      expect(result.stdout).toContain(`  uuid ${testRecord.uuid}`);
    });
  });

  describe('json format', () => {
    it('should output status in JSON format', () => {
      const result = runCli([
        '--status',
        testRecord.uuid,
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);

      // Parse the JSON output
      const parsed = JSON.parse(result.stdout);
      expect(parsed.uuid).toBe(testRecord.uuid);
      expect(parsed.command).toBe('echo hello world');
      expect(parsed.status).toBe('executed');
      expect(parsed.exitCode).toBe(0);
      expect(parsed.pid).toBe(12345);
      expect(parsed.processIds).toEqual({ wrapperPid: 12345 });
    });
  });

  describe('text format', () => {
    it('should output status in human-readable text format', () => {
      const result = runCli([
        '--status',
        testRecord.uuid,
        '--output-format',
        'text',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Execution Status');
      expect(result.stdout).toContain('UUID:');
      expect(result.stdout).toContain(testRecord.uuid);
      expect(result.stdout).toContain('Status:');
      expect(result.stdout).toContain('executed');
      expect(result.stdout).toContain('Command:');
      expect(result.stdout).toContain('echo hello world');
      expect(result.stdout).toContain('Exit Code:');
      expect(result.stdout).toContain('0');
    });
  });

  describe('error handling', () => {
    it('should show error for non-existent UUID', () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      const result = runCli(['--status', fakeUuid]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No execution found with UUID');
      expect(result.stderr).toContain(fakeUuid);
    });

    it('should show error when tracking is disabled', () => {
      const result = runCli(['--status', testRecord.uuid], {
        START_DISABLE_TRACKING: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('tracking is disabled');
    });
  });

  describe('--list query functionality', () => {
    it('should output all tracked executions in links-notation format by default', () => {
      const executingRecord = new ExecutionRecord({
        command: 'sleep 100',
        pid: 99999,
        logPath: '/tmp/executing.log',
        startTime: '2026-04-24T10:00:00.000Z',
      });
      store.save(executingRecord);

      const result = runCli(['--list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^executions\n/);
      expect(result.stdout).toContain('  count 2');
      expect(result.stdout).toContain(`    ${testRecord.uuid}`);
      expect(result.stdout).toContain(`    ${executingRecord.uuid}`);
      expect(result.stdout).toContain('      command "echo hello world"');
      expect(result.stdout).toContain('      command "sleep 100"');
      expect(result.stdout).toContain('      status executed');
      expect(result.stdout).toContain('      status executing');
    });

    it('should output all tracked executions in JSON format', () => {
      const executingRecord = new ExecutionRecord({
        command: 'sleep 100',
        pid: 99999,
        logPath: '/tmp/executing.log',
      });
      store.save(executingRecord);

      const result = runCli(['--list', '--output-format', 'json']);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.count).toBe(2);
      expect(parsed.executions.length).toBe(2);
      expect(parsed.executions.map((record) => record.uuid)).toContain(
        testRecord.uuid
      );
      expect(parsed.executions.map((record) => record.uuid)).toContain(
        executingRecord.uuid
      );
      const executing = parsed.executions.find(
        (record) => record.uuid === executingRecord.uuid
      );
      expect(executing.status).toBe('executing');
      expect(executing.processIds).toEqual({ wrapperPid: 99999 });
      expect(executing.currentTime).toBeDefined();
    });

    it('should show count zero when no records are stored', () => {
      cleanupTestDir();

      const result = runCli(['--list']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^executions\n/);
      expect(result.stdout).toContain('  count 0');
      expect(result.stdout).toContain('  records ()');
    });

    it('should show error when tracking is disabled', () => {
      const result = runCli(['--list'], {
        START_DISABLE_TRACKING: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('tracking is disabled');
    });
  });

  describe('--upload-log functionality', () => {
    it('should upload a private sanitized copy and preserve the stored log', () => {
      const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-log-bin-'));
      const logPath = path.join(TEST_APP_FOLDER, 'command.log');
      const capturePath = path.join(fakeBin, 'capture.json');
      const token = ['gh', 'p_', 'a'.repeat(36)].join('');
      const customSecret = 'fake-custom-credential';
      const original = `captured command output\n${token}\n${customSecret}\n`;
      fs.writeFileSync(logPath, original, 'utf8');
      createFakeUploader(fakeBin, 'fake uploader received');

      testRecord.logPath = logPath;
      store.save(testRecord);

      const result = runCli(['--upload-log', testRecord.uuid], {
        PATH: fakeBin,
        HOME: fakeBin,
        UPLOAD_CAPTURE: capturePath,
        EXAMPLE_API_KEY: customSecret,
        GH_UPLOAD_PUBLIC: 'true',
      });

      expect(result.exitCode).toBe(0);
      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      expect(captured.args[0]).not.toBe(logPath);
      expect(captured.args[1]).toBe('--private');
      expect(captured.content).toContain('captured command output');
      expect(captured.content).toContain('[REDACTED]');
      expect(captured.content).not.toContain(token);
      expect(captured.content).not.toContain(customSecret);
      if (process.platform !== 'win32') {
        expect(captured.mode).toBe(0o600);
      }
      expect(result.stdout).toContain(
        `fake uploader received: ${captured.args[0]}`
      );
      expect(result.stderr).toBe('');
      expect(fs.readFileSync(logPath, 'utf8')).toBe(original);
      expect(fs.existsSync(captured.args[0])).toBe(false);

      fs.rmSync(fakeBin, { recursive: true, force: true });
    });

    it('should install gh-upload-log when it is missing before uploading', () => {
      if (process.platform === 'win32') {
        console.log('  Skipping: shell fixture uses POSIX scripts');
        return;
      }

      const fakeBin = fs.mkdtempSync(
        path.join(os.tmpdir(), 'upload-log-install-bin-')
      );
      const installMarker = path.join(fakeBin, 'install.log');
      const capturePath = path.join(fakeBin, 'capture.json');
      const logPath = path.join(TEST_APP_FOLDER, 'install-command.log');
      const token = ['gh', 'p_', 'b'.repeat(36)].join('');
      const original = `captured command output\n${token}\n`;
      fs.writeFileSync(logPath, original, 'utf8');
      const uploaderScript = fakeUploaderScript(
        fakeBin,
        'installed uploader received'
      );

      createExecutable(
        path.join(fakeBin, 'bun'),
        [
          '#!/bin/sh',
          `echo "$@" > "${installMarker}"`,
          `cat > "${path.join(fakeBin, 'gh-upload-log')}" <<'SCRIPT'`,
          uploaderScript,
          'SCRIPT',
          `chmod +x "${path.join(fakeBin, 'gh-upload-log')}"`,
          'exit 0',
          '',
        ].join('\n')
      );

      testRecord.logPath = logPath;
      store.save(testRecord);

      const result = runCli(['--upload-log', testRecord.uuid], {
        PATH: `${fakeBin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
        HOME: fakeBin,
        UPLOAD_CAPTURE: capturePath,
      });

      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(installMarker, 'utf8').trim()).toBe(
        'install -g gh-upload-log'
      );
      expect(result.stdout).toContain('gh-upload-log not found');
      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      expect(captured.args[0]).not.toBe(logPath);
      expect(captured.args[1]).toBe('--private');
      expect(captured.content).toContain('captured command output');
      expect(captured.content).toContain('[REDACTED]');
      expect(captured.content).not.toContain(token);
      expect(captured.mode).toBe(0o600);
      expect(result.stdout).toContain(
        `installed uploader received: ${captured.args[0]}`
      );
      expect(fs.readFileSync(logPath, 'utf8')).toBe(original);
      expect(fs.existsSync(captured.args[0])).toBe(false);

      fs.rmSync(fakeBin, { recursive: true, force: true });
    });

    it('should upload the original privately only with explicit --no-sanitize', () => {
      const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-raw-bin-'));
      const capturePath = path.join(fakeBin, 'capture.json');
      const logPath = path.join(TEST_APP_FOLDER, 'raw-command.log');
      const token = ['gh', 'p_', 'c'.repeat(36)].join('');
      const original = `captured command output\n${token}\n`;
      fs.writeFileSync(logPath, original, 'utf8');
      createFakeUploader(fakeBin, 'raw uploader received');
      testRecord.logPath = logPath;
      store.save(testRecord);

      const result = runCli(
        ['--upload-log', testRecord.uuid, '--no-sanitize'],
        {
          PATH: fakeBin,
          HOME: fakeBin,
          UPLOAD_CAPTURE: capturePath,
          GH_UPLOAD_PUBLIC: 'true',
        }
      );

      expect(result.exitCode).toBe(0);
      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
      expect(captured.args).toEqual([logPath, '--private']);
      expect(captured.content).toBe(original);
      expect(fs.readFileSync(logPath, 'utf8')).toBe(original);
      fs.rmSync(fakeBin, { recursive: true, force: true });
    });

    it('should show an error when the stored log file is missing', () => {
      testRecord.logPath = path.join(TEST_APP_FOLDER, 'missing.log');
      store.save(testRecord);

      const result = runCli(['--upload-log', testRecord.uuid]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Log file not found');
      expect(result.stderr).toContain(testRecord.logPath);
    });
  });

  describe('executing status', () => {
    it('should show executing status for ongoing commands', () => {
      // Create an executing (not completed) record
      const executingRecord = new ExecutionRecord({
        command: 'sleep 100',
        pid: 99999,
        logPath: '/tmp/executing.log',
      });
      store.save(executingRecord);

      const result = runCli([
        '--status',
        executingRecord.uuid,
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('executing');
      expect(parsed.exitCode).toBeNull();
      expect(parsed.endTime).toBeNull();
    });

    it('should include currentTime for executing commands (JSON)', () => {
      const beforeQuery = Date.now();
      const executingRecord = new ExecutionRecord({
        command: 'sleep 100',
        pid: 99999,
        logPath: '/tmp/executing.log',
      });
      store.save(executingRecord);

      const result = runCli([
        '--status',
        executingRecord.uuid,
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.currentTime).toBeDefined();
      // currentTime should be a valid ISO timestamp at or after the query started
      const currentTimeMs = new Date(parsed.currentTime).getTime();
      expect(Number.isNaN(currentTimeMs)).toBe(false);
      expect(currentTimeMs).toBeGreaterThanOrEqual(beforeQuery - 1);
      expect(currentTimeMs).toBeLessThanOrEqual(Date.now() + 1);
      // Should be >= startTime
      expect(currentTimeMs).toBeGreaterThanOrEqual(
        new Date(parsed.startTime).getTime()
      );
    });

    it('should not include currentTime for completed commands (JSON)', () => {
      // testRecord from beforeEach is already completed
      const result = runCli([
        '--status',
        testRecord.uuid,
        '--output-format',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('executed');
      expect(parsed.currentTime).toBeUndefined();
    });

    it('should include currentTime in links-notation for executing commands', () => {
      const executingRecord = new ExecutionRecord({
        command: 'sleep 100',
        pid: 99999,
        logPath: '/tmp/executing.log',
      });
      store.save(executingRecord);

      const result = runCli(['--status', executingRecord.uuid]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('status executing');
      // currentTime should appear as an indented property with an ISO timestamp value
      expect(result.stdout).toMatch(
        /\n {2}currentTime "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
      );
    });

    it('should indent nested process ID arrays in links-notation', () => {
      if (process.platform === 'win32') {
        console.log(
          '  Skipping: POSIX screen/pgrep process tree fixture is not available on Windows'
        );
        return;
      }

      const executingRecord = new ExecutionRecord({
        command: 'sleep 100',
        pid: 667105,
        logPath: '/tmp/executing.log',
        options: {
          isolated: 'screen',
          isolationMode: 'detached',
          sessionName: 'issue-126-screen',
        },
      });
      store.save(executingRecord);

      const result = runCli(['--status', executingRecord.uuid], {
        PATH: `${path.join(__dirname, 'fixtures', 'issue-126-bin')}${path.delimiter}${process.env.PATH}`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        [
          '  processIds',
          '      wrapperPid 667105',
          '      screenPid 667120',
          '      commandPids',
          '        (',
          '          667121',
          '          667122',
          '        )',
        ].join('\n')
      );
      expect(result.stdout).not.toContain('\n(\n');
    });

    it('should include Current Time in text format for executing commands', () => {
      const executingRecord = new ExecutionRecord({
        command: 'sleep 100',
        pid: 99999,
        logPath: '/tmp/executing.log',
      });
      store.save(executingRecord);

      const result = runCli([
        '--status',
        executingRecord.uuid,
        '--output-format',
        'text',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Status:');
      expect(result.stdout).toContain('executing');
      expect(result.stdout).toContain('Current Time:');
    });

    it('should not include Current Time in text format for completed commands', () => {
      const result = runCli([
        '--status',
        testRecord.uuid,
        '--output-format',
        'text',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('Current Time:');
    });
  });
});

console.log('=== Status Query Integration Tests ===');
