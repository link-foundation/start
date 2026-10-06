// Finite reproduction: no Docker daemon, background process or memory stress.
// Run: node --max-old-space-size=128 experiments/issue-187-resume-state.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  ExecutionRecord,
  ExecutionStore,
} = require('../js/src/lib/execution-store');
const { resumeExecution } = require('../js/src/lib/execution-resume');
const { enrichDetachedStatus } = require('../js/src/lib/status-formatter');
const { SessionState } = require('../js/src/lib/session-probe');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-187-'));
try {
  const logPath = path.join(directory, 'execution.log');
  const oldLog =
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n\n==================================================\nFinished: 2026-01-01 00:01:00.000\nExit Code: 137\n';
  fs.writeFileSync(logPath, oldLog);
  const store = new ExecutionStore({ appFolder: directory, useLinks: false });
  const record = new ExecutionRecord({
    command: 'worker',
    logPath,
    startTime: '2026-01-01T00:00:00.000Z',
    status: 'executed',
    exitCode: 137,
    endTime: '2026-01-01T00:01:00.000Z',
    memoryExhausted: true,
    memoryExhaustedReason: 'cgroup-oom-killer',
    cgroupMemory: {
      limitBytes: 128,
      peakBytes: 128,
      oomEvents: 1,
      oomKills: 1,
    },
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: 'issue-187-absent',
    },
  });
  store.save(record);
  await resumeExecution(store, record.uuid, {
    probe: () => ({ alive: false, state: SessionState.STOPPED }),
    runner: () => ({ success: true, stdout: 'container-id', status: 0 }),
    startWatcher: () => {},
  });
  const current = enrichDetachedStatus(store.get(record.uuid));
  console.log(
    JSON.stringify(
      {
        status: current.status,
        exitCode: current.exitCode,
        memoryExhausted: current.memoryExhausted ?? null,
        expectedLogOffset: Buffer.byteLength(oldLog),
        attempt: current.attempt,
        attemptHistory: current.attemptHistory,
        lifecycle: fs
          .readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('[Start Command Lifecycle] '))
          .map((line) =>
            JSON.parse(line.slice('[Start Command Lifecycle] '.length))
          ),
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
