/**
 * Regression tests for issue #241: a daemon restart was attributed only from
 * `journalctl -u docker.service`. With a mounted docker.sock
 * (Docker-outside-of-Docker) there is no host journal, so a task that the
 * restart force-killed ended with `Exit evidence: unavailable`.
 *
 * `docker events` cannot help (its buffer does not survive the restart), but
 * `State.FinishedAt` / `State.StartedAt` of the other containers do.
 */

const { describe, it, expect, afterEach } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const evidence = require('../src/lib/exit-evidence');
const { resolveExitReason } = require('../src/lib/exit-reason');

const TASK = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const FINISHED = '2026-10-21T10:05:00.123456789Z';
const state = (id, finished, started, exit, oom = 'false') =>
  `${id} ${finished} ${started} ${exit} ${oom}`;
// Two containers that finished in the same second, the shape of a restart.
const TOGETHER = [
  state(TASK, FINISHED, '2026-10-21T10:00:00Z', 137),
  state(PEER, '2026-10-21T10:05:00.9Z', '2026-10-21T09:00:00Z', 137),
].join('\n');

/** Runner answering like a daemon reached through a mounted socket. */
function socketOnlyRunner(states, calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === 'journalctl') {
      // No host journal inside the container.
      return { success: false, stdout: '' };
    }
    if (args[0] === 'inspect' && args[2] === '{{.Id}}') {
      return { success: true, stdout: `${TASK}\n` };
    }
    if (args[0] === 'events') {
      return { success: true, stdout: '' };
    }
    if (args[0] === 'ps') {
      return { success: true, stdout: `${TASK}\n${PEER}\n` };
    }
    if (args[0] === 'inspect') {
      return { success: true, stdout: states };
    }
    return { success: false, stdout: '' };
  };
}

const collect = (states, extra = {}, calls) =>
  evidence.collectExitEvidence(
    {
      containerName: 'task',
      sample: '',
      finishedAt: FINISHED,
      exitCode: 137,
      oomKilled: false,
      ...extra,
    },
    socketOnlyRunner(states, calls)
  );

describe('issue #241: daemon-restart evidence without the host journal', () => {
  it('attributes two containers that finished in the same second to the daemon', () => {
    const calls = [];
    const line = collect(TOGETHER, {}, calls);
    expect(line).toBe(evidence.DAEMON_RESTART_API);
    expect(calls).toContainEqual(['docker', 'ps', '-a', '-q', '--no-trunc']);
    // The task itself is never its own witness.
    const inspect = calls.find(
      (call) => call[1] === 'inspect' && call[3] !== '{{.Id}}'
    );
    expect(inspect.slice(4)).toEqual([PEER]);
    expect(
      resolveExitReason({ exitCode: 137, oomKilled: false, logTail: line })
    ).toBe('killed (docker daemon restart)');
  });

  it('reports which source supported the attribution', () => {
    expect(evidence.fromLog(evidence.DAEMON_RESTART_API)).toEqual({
      mainOom: false,
      daemonRestart: true,
      daemonRestartSource: 'api',
    });
    expect(evidence.fromLog(evidence.DAEMON_RESTART)).toEqual({
      mainOom: false,
      daemonRestart: true,
      daemonRestartSource: 'journal',
    });
    expect(evidence.fromLog(evidence.MAIN_OOM)).toEqual({
      mainOom: true,
      daemonRestart: false,
    });
  });

  it('counts a container restarted after it finished, whose ExitCode moby reset to 0', () => {
    const restarted = state(
      PEER,
      '2026-10-21T10:04:52Z',
      '2026-10-21T10:05:20Z',
      0
    );
    expect(evidence.daemonRestartApiEvidence(restarted, TASK, FINISHED)).toBe(
      true
    );
  });

  for (const [name, peer] of [
    [
      'an OOM-killed peer',
      state(PEER, FINISHED, '2026-10-21T09:00:00Z', 137, 'true'),
    ],
    [
      'a peer that finished 30 s apart',
      state(PEER, '2026-10-21T10:05:30.2Z', '2026-10-21T09:00:00Z', 137),
    ],
    [
      'a peer that exited on its own',
      state(PEER, FINISHED, '2026-10-21T09:00:00Z', 0),
    ],
    [
      'a peer that never ran',
      state(PEER, '0001-01-01T00:00:00Z', '0001-01-01T00:00:00Z', 0),
    ],
    [
      'only the task itself',
      state(TASK, FINISHED, '2026-10-21T09:00:00Z', 137),
    ],
    ['malformed output', 'Error: No such object: gone'],
  ]) {
    it(`does not attribute ${name}`, () => {
      expect(evidence.daemonRestartApiEvidence(peer, TASK, FINISHED)).toBe(
        false
      );
      expect(collect(peer)).toBe(
        'Exit evidence: unavailable (no attributed exit-time OOM or daemon restart evidence)'
      );
    });
  }

  it('also works for a remote daemon, where no journal is consulted', () => {
    const original = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = 'tcp://docker.example:2376';
    try {
      const calls = [];
      expect(collect(TOGETHER, {}, calls)).toBe(evidence.DAEMON_RESTART_API);
      expect(calls.some(([command]) => command === 'journalctl')).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.DOCKER_HOST;
      } else {
        process.env.DOCKER_HOST = original;
      }
    }
  });

  it('keeps journal and attempt-scoped OOM evidence ahead of the API check', () => {
    const calls = [];
    const line = collect(
      TOGETHER,
      { oomKilled: true, sample: '64 63 3 2 1792577100 1792577100' },
      calls
    );
    expect(line).toBe(evidence.MAIN_OOM);
    expect(calls.some((call) => call[1] === 'ps')).toBe(false);
  });
});

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('issue #241: --status collects evidence the lost watcher never wrote', () => {
  it('reports a daemon restart for a DooD task whose watcher died with the daemon', () => {
    if (process.platform === 'win32') {
      console.log('  Skipping: the docker stub needs a POSIX /bin/sh');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-241-'));
    tempDirs.push(dir);
    const docker = path.join(dir, 'docker');
    fs.writeFileSync(
      docker,
      [
        '#!/bin/sh',
        'case "$1 $3" in',
        `  "inspect {{.Id}}") echo ${TASK} ;;`,
        `  "inspect {{.Id}} "*) echo '${state(PEER, '2026-10-21T10:05:00.9Z', '2026-10-21T10:05:30Z', 0)}' ;;`,
        `  "inspect "*) echo 'false 137 false 2026-10-21T10:00:00Z ${FINISHED}' ;;`,
        `  "ps "*) printf '%s\\n' ${TASK} ${PEER} ;;`,
        '  "events "*) ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n')
    );
    fs.chmodSync(docker, 0o755);
    // No host journal, as inside a container with a mounted docker.sock.
    fs.writeFileSync(path.join(dir, 'journalctl'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(dir, 'journalctl'), 0o755);
    const saved = {
      START_DOCKER_BIN: process.env.START_DOCKER_BIN,
      PATH: process.env.PATH,
      DOCKER_HOST: process.env.DOCKER_HOST,
    };
    process.env.START_DOCKER_BIN = docker;
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    delete process.env.DOCKER_HOST;
    try {
      const {
        ExecutionStore,
        ExecutionRecord,
      } = require('../src/lib/execution-store');
      const { queryStatus } = require('../src/lib/status-formatter');
      const store = new ExecutionStore({ appFolder: dir, useLinks: false });
      const record = new ExecutionRecord({
        command: 'sleep 600',
        options: {
          isolated: 'docker',
          isolationMode: 'detached',
          sessionName: 'task-241',
        },
      });
      record.logPath = path.join(dir, 'task.log');
      // The watcher died before it could log anything after the output.
      fs.writeFileSync(record.logPath, 'working\n');
      store.save(record);
      const status = JSON.parse(queryStatus(store, record.uuid, 'json').output);
      expect(status.status).toBe('executed');
      expect(status.exitCode).toBe(137);
      expect(status.exitReason).toBe('killed (docker daemon restart)');
      expect(status.options.exitEvidence).toEqual({
        mainOom: false,
        daemonRestart: true,
        daemonRestartSource: 'api',
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
