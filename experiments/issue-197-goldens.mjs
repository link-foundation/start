/** Capture fixed, platform-independent contracts for both native runtimes. */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { ExecutionRecord } = require('../js/src/lib/execution-store');
const { formatRecord } = require('../js/src/lib/status-formatter');
const record = {
  uuid: '123e4567-e89b-42d3-a456-426614174000',
  pid: 12345,
  status: 'executed',
  exitCode: 0,
  command: 'echo hello',
  logPath: '/tmp/start-golden.log',
  startTime: '2026-10-10T00:00:00Z',
  endTime: '2026-10-10T00:00:01Z',
  workingDirectory: '/workspace',
  shell: '/bin/sh',
  platform: 'linux',
  options: {},
};
const fixture = {
  schemaVersion: 1,
  'cli-parsing': [
    { name: 'plain argv', argv: ['echo', 'hello'], command: 'echo hello', rawCommand: ['echo', 'hello'], options: { isolated: null, detached: false, status: null } },
    { name: 'explicit tmux separator', argv: ['--isolated=tmux', '-d', '--session', 'fixture-session', '--', 'echo', 'hello'], command: 'echo hello', rawCommand: ['echo', 'hello'], options: { isolated: 'tmux', detached: true, session: 'fixture-session' } },
    { name: 'query without command', argv: ['--status', 'fixture-session', '--output-format', 'json'], command: '', rawCommand: [], options: { status: 'fixture-session', outputFormat: 'json' } },
    { name: 'docker resource flags', argv: ['--isolated', 'docker', '--memory=256m', '--cpus=1.5', '--', 'echo', 'hello'], command: 'echo hello', rawCommand: ['echo', 'hello'], options: { isolated: 'docker', memory: '256m', cpus: '1.5' } },
    { name: 'unknown wrapper option', argv: ['--definitely-unknown'], error: 'Unknown wrapper option' },
    { name: 'conflicting modes', argv: ['--attached', '--detached', '--', 'echo'], error: 'attached' },
  ],
  'isolation-arguments': [
    { name: 'empty runtime flags', options: {}, argv: [] },
    { name: 'resource, mount and network boundaries', options: { privileged: true, env: ['MESSAGE=hello world'], labels: ['team=golden'], volumes: ['/host path:/work'], mounts: ['type=tmpfs,destination=/tmp'], networks: ['private', 'second'], networkAliases: ['worker'], resourceLimits: ['--memory=256m', '--cpus=1.5'] }, argv: ['--privileged', '-e', 'MESSAGE=hello world', '--label', 'team=golden', '-v', '/host path:/work', '--mount', 'type=tmpfs,destination=/tmp', '--network', 'private', '--network-alias', 'worker', '--memory=256m', '--cpus=1.5'] },
  ],
  'status-output': { record, json: record, text: formatRecord(new ExecutionRecord(record), 'text') },
  'execution-record-format': [record, { ...record, exitCode: 137, oomKilled: true, exitReason: 'Killed (SIGKILL)', memoryExhausted: true, memoryExhaustedReason: 'Docker reported OOMKilled', options: { isolated: 'docker', session: 'fixture-session', resourceLimits: ['--memory=256m'] } }],
  'parity-threshold': [{ javascript: 0, minimumRust: 0 }, { javascript: 10, minimumRust: 9 }, { javascript: 101, minimumRust: 90.9 }],
};
writeFileSync('parity/fixtures/contracts.json', `${JSON.stringify(fixture, null, 2)}\n`);
