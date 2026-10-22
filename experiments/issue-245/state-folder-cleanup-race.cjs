// Reproduces the #245 CI flake of experiments/issue-236/docker-smoke.cjs
// without Docker: "ENOTEMPTY, Directory not empty" from fs.rmSync on the
// START_APP_FOLDER while a detached watcher still finalizes the record.
//
// A background process stands in for the watcher: it inherits
// START_APP_FOLDER and keeps doing what atomic_write does (create
// `executions.lino.<pid>.<n>.tmp`, rename it over the store) for a while.
// The plain rmSync used by the smoke test races with it (Node throws
// ENOTEMPTY, Bun leaves the folder behind); removeStateFolder waits for the
// writer to exit first and always succeeds.
//
// Run: node experiments/issue-245/state-folder-cleanup-race.cjs [trials]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  processesUsing,
  removeStateFolder,
} = require('../issue-236/state-folder.cjs');

const trials = Number(process.argv[2] || 20);
const WRITER = `
const fs = require('node:fs');
const path = require('node:path');
const store = path.join(process.env.START_APP_FOLDER, 'executions.lino');
const until = Date.now() + Number(process.argv[1]);
for (let n = 0; Date.now() < until; n++) {
  const temporary = store + '.' + process.pid + '.' + n + '.tmp';
  try {
    fs.writeFileSync(temporary, 'record ' + n);
    fs.renameSync(temporary, store);
  } catch {}
}`;

function trial(remove) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-race-245-'));
  fs.writeFileSync(path.join(state, 'executions.lino'), 'record');
  const writer = spawn(process.execPath, ['-e', WRITER, '400'], {
    env: { ...process.env, START_APP_FOLDER: state },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5000;
  while (processesUsing(state).length === 0 && Date.now() < deadline);
  try {
    remove(state);
    return { ok: true, leftover: fs.existsSync(state) };
  } catch (error) {
    return { ok: false, code: error.code };
  } finally {
    writer.kill();
    fs.rmSync(state, { recursive: true, force: true, maxRetries: 10 });
  }
}

const naive = Array.from({ length: trials }, () =>
  trial((state) => fs.rmSync(state, { recursive: true, force: true }))
);
const fixed = Array.from({ length: trials }, () => trial(removeStateFolder));
const failures = naive.filter((result) => !result.ok);
console.log(
  JSON.stringify({
    trials,
    naiveFailures: failures.length,
    naiveCodes: [...new Set(failures.map((result) => result.code))],
    naiveLeftovers: naive.filter((result) => result.leftover).length,
    fixedFailures: fixed.filter((result) => !result.ok).length,
    fixedLeftovers: fixed.filter((result) => result.leftover).length,
  })
);
// Node throws ENOTEMPTY; Bun's rmSync returns and leaves the folder behind.
const raced = naive.filter((result) => !result.ok || result.leftover);
assert.ok(raced.length > 0, 'plain rmSync should race with the writer');
assert.deepEqual(
  failures.map((result) => result.code).filter((code) => code !== 'ENOTEMPTY'),
  []
);
assert.ok(fixed.every((result) => result.ok && !result.leftover));
console.log(
  'removeStateFolder waits for the writer; plain rmSync races with it'
);
