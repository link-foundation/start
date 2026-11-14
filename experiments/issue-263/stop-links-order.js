#!/usr/bin/env node
/**
 * Issue #263: print the JavaScript `--stop` Links Notation report for a
 * detached Docker execution, the reference for the key order Rust must
 * reproduce (wrapperPid, containerId, containerPid — not sorted).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const { ExecutionRecord, ExecutionStore } = require(
  path.join(root, 'js/src/lib/execution-store')
);
const { controlExecution } = require(
  path.join(root, 'js/src/lib/execution-control')
);

const appFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'start-263-stop-'));
try {
  const store = new ExecutionStore({ appFolder, useLinks: false });
  store.save(
    new ExecutionRecord({
      uuid: 'control-test-uuid',
      command: 'sleep 100',
      pid: 12345,
      status: 'executing',
      logPath: '/tmp/control-test.log',
      options: {
        isolated: 'docker',
        isolationMode: 'detached',
        sessionName: 'docker-session',
        containerId: 'abc123',
      },
    })
  );
  const runner = (command, args) => ({
    success: true,
    stdout: args[0] === 'inspect' ? 'abcdef 4242\n' : '',
    stderr: '',
    status: 0,
  });
  const result = controlExecution(store, 'control-test-uuid', 'stop', runner);
  console.log(result.output);
} finally {
  fs.rmSync(appFolder, { recursive: true, force: true });
}
