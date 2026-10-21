// Measures lino-objects-codec decode cost vs JSON.parse for a store shaped
// like the issue's (39 records, ~140 KB). Usage: bun experiments/issue-243-decode-cost.js [records]
const path = require('path');
const codec = require(
  path.join(__dirname, '../js/node_modules/lino-objects-codec')
);
const { ExecutionRecord } = require('../js/src/lib/execution-store');
const n = Number(process.argv[2] || 39);
const records = [];
for (let i = 0; i < n; i++) {
  const r = new ExecutionRecord({
    command: `solve https://github.com/org/repo/issues/${i} --model opus --attach-logs --verbose`,
    exitCode: i % 3 ? 0 : 1,
    logPath: `/tmp/start-command-${i}.log`,
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      sessionName: `task-${i}`,
      image: 'konard/hive-mind:latest',
      memory: '4g',
      cpus: '2',
      keepAlive: false,
      containerId: `abcdef${i}`.padEnd(64, '0'),
      user: 'box',
      shell: 'bash',
      env: { A: '1', B: 'two', C: 'three' },
      autoRemoveDockerContainer: true,
      cgroup: { memoryMax: '4294967296', memoryPeak: '1234567', oomKill: 0 },
    },
  });
  r.complete(i % 3 ? 0 : 1);
  records.push(r.toObject());
}
const lino = codec.encode({ obj: records });
const json = JSON.stringify(records);
const time = (label, fn, reps = 5) => {
  fn();
  const t = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / reps;
  console.log(
    `${label}: ${ms.toFixed(2)} ms (${(ms / n).toFixed(3)} ms/record)`
  );
};
console.log(`records=${n} lino=${lino.length} bytes json=${json.length} bytes`);
time('lino decode', () => codec.decode({ notation: lino }));
time('JSON.parse', () => JSON.parse(json), 50);
const crypto = require('crypto');
time(
  'sha256(lino)',
  () => crypto.createHash('sha256').update(lino).digest('hex'),
  50
);
