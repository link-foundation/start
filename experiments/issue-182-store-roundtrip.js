// Does the top-level record.cgroupMemory object (issue #182) survive the
// .lino store round trip, including null fields?
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ExecutionStore, ExecutionRecord } = require('../js/src/lib/execution-store');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-182-'));
const store = new ExecutionStore({ appFolder: dir, useLinks: false });
const record = new ExecutionRecord({
  command: 'x',
  cgroupMemory: { limitBytes: null, peakBytes: 123456789, oomEvents: 0, oomKills: 3 },
});
store.save(record);
console.log(JSON.stringify(store.get(record.uuid).cgroupMemory));
console.log(fs.readFileSync(path.join(dir, 'executions.lino'), 'utf8').slice(0, 2000));
fs.rmSync(dir, { recursive: true, force: true });
