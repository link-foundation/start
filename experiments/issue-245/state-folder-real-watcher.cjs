// Real-Docker check for experiments/issue-236/state-folder.cjs: a detached
// launch leaves a completion watcher that inherits START_APP_FOLDER; the
// cleanup must see it, wait for it to finalize, and only then remove the
// folder (nothing may recreate it afterwards).
// Run: node experiments/issue-245/state-folder-real-watcher.cjs [js|rust]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  processesUsing,
  removeStateFolder,
} = require('../issue-236/state-folder.cjs');

const root = path.resolve(__dirname, '../..');
const edition = process.argv[2] || 'rust';
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'real-watcher-245-'));
const session = `real-watcher-245-${process.pid}`;
const env = {
  ...process.env,
  START_APP_FOLDER: state,
  START_DISABLE_AUTO_ISSUE: '1',
  START_DISABLE_LOG_UPLOAD: '1',
};
const argv = [
  '--isolated',
  'docker',
  '--detached',
  '--image',
  'alpine:3.20',
  '--session',
  session,
  '--',
  'sleep',
  '2',
];
const [program, args] =
  edition === 'rust'
    ? [path.join(root, 'rust/target/release/start'), argv]
    : [process.execPath, [path.join(root, 'js/src/bin/cli.js'), ...argv]];
try {
  const launch = spawnSync(program, args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(launch.status, 0, `${launch.stdout}\n${launch.stderr}`);
  const watchers = processesUsing(state);
  console.log(
    JSON.stringify({ edition, watchersAfterLaunch: watchers.length })
  );
  assert.ok(
    watchers.length > 0,
    'the detached watcher should still be running'
  );
  const started = Date.now();
  removeStateFolder(state);
  console.log(JSON.stringify({ waitedMs: Date.now() - started }));
  assert.equal(processesUsing(state).length, 0);
  assert.equal(fs.existsSync(state), false);
  spawnSync('sleep', ['1']);
  assert.equal(fs.existsSync(state), false, 'nothing recreated the folder');
  console.log('cleanup waited for the real watcher and removed the folder');
} finally {
  spawnSync('docker', ['rm', '-f', session]);
  fs.rmSync(state, { recursive: true, force: true });
}
