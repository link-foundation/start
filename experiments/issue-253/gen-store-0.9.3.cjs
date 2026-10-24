// Issue #253: write the 0.9.3 store fixture with the current JS ExecutionStore
// (lino-objects-codec 0.9.x). Usage: node gen-store-0.9.3.cjs <js/src/lib/execution-store.js>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExecutionStore, ExecutionRecord } = require(process.argv[2]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-093-'));
const store = new ExecutionStore({ appFolder: dir, useLinks: false });
const record = new ExecutionRecord({
  uuid: '25300000-0000-4000-8000-000000000930',
  command: 'echo "readable store" (with) \\ odd chars \'q\' 世界',
  pid: 4242,
  logPath: '/tmp/start-253-readable.log',
  workingDirectory: '/tmp',
  shell: '/bin/sh',
  platform: 'linux',
  options: { isolated: 'docker', keepAlive: false, nested: { list: [1, 'two', null] } },
});
record.startTime = '2026-10-01T00:00:00.000Z';
record.complete(0);
record.endTime = '2026-10-01T00:00:01.000Z';
store.save(record);
process.stdout.write(fs.readFileSync(path.join(dir, 'executions.lino'), 'utf8'));
fs.rmSync(dir, { recursive: true, force: true });
