// Real-daemon measurement for issue #243: `$ --list` and `$ --status` against
// a 39-record store shaped like the issue's (2 running task containers, a few
// kept exited containers, many finished records). Every `docker` call goes
// through a counting wrapper. Each run starts from the same pristine store, so
// removals persisted by one run cannot change the next.
//
// Usage: node experiments/issue-243-real-docker.js <before-repo> <after-repo>
// (each repo needs js/node_modules). Bounded: containers sleep 120 s at most
// and are removed on exit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const [beforeRoot, afterRoot] = process.argv
  .slice(2)
  .map((p) => path.resolve(p));
if (!beforeRoot || !afterRoot) {
  console.error('usage: issue-243-real-docker.js <before-repo> <after-repo>');
  process.exit(2);
}
const tag = `b243-${process.pid}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-243-real-'));
const containers = [];
function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}
function cleanup() {
  if (containers.length) {
    spawnSync('docker', ['rm', '-f', ...containers], { stdio: 'ignore' });
  }
  fs.rmSync(work, { recursive: true, force: true });
}
process.on('exit', cleanup);

const image = process.env.IMAGE || 'alpine:3.23';
for (let i = 0; i < 2; i++) {
  const name = `${tag}-run-${i}`;
  docker('run', '-d', '--name', name, image, 'sleep', '120');
  containers.push(name);
}
for (let i = 0; i < 6; i++) {
  const name = `${tag}-kept-${i}`;
  containers.push(name);
  // A non-zero exit is the point; execFileSync would throw on it.
  spawnSync('docker', [
    'run',
    '--name',
    name,
    image,
    'sh',
    '-c',
    `exit ${i % 2}`,
  ]);
}

// Seed the store with the "after" tree's store (the format is unchanged).
const seedHome = path.join(work, 'seed');
const { ExecutionStore, ExecutionRecord } = require(
  path.join(afterRoot, 'js/src/lib/execution-store.js')
);
const store = new ExecutionStore({
  appFolder: path.join(seedHome, '.start-command'),
  useLinks: false,
});
const uuids = {};
function add(kind, i, options, extra = {}) {
  const record = new ExecutionRecord({
    command: `solve https://github.com/org/repo/issues/${kind}-${i} --model opus`,
    logPath: path.join(work, `${kind}-${i}.log`),
    options: {
      isolated: 'docker',
      isolationMode: 'detached',
      image,
      memory: '4g',
      ...options,
    },
  });
  if (extra.done) {
    record.complete(extra.exitCode || 0);
  }
  Object.assign(record, extra.fields || {});
  store.save(record);
  uuids[`${kind}-${i}`] = record.uuid;
}
const id = (name) => docker('inspect', '-f', '{{.Id}}', name);
for (let i = 0; i < 2; i++) {
  add('run', i, { sessionName: `${tag}-run-${i}` });
}
for (let i = 0; i < 6; i++) {
  const name = `${tag}-kept-${i}`;
  add(
    'kept',
    i,
    { sessionName: name, containerId: id(name), keepAlive: true },
    {
      done: true,
      exitCode: i % 2,
    }
  );
}
for (let i = 0; i < 14; i++) {
  add(
    'gone',
    i,
    { sessionName: `${tag}-gone-${i}`, containerId: `deadbeef${i}` },
    {
      done: true,
    }
  );
}
for (let i = 0; i < 12; i++) {
  add(
    'removed',
    i,
    { sessionName: `${tag}-removed-${i}`, containerId: `cafe${i}` },
    {
      done: true,
      fields: {
        containerState: 'removed',
        containerRemovedObservedAt: '2026-10-20T09:30:00.000Z',
      },
    }
  );
}
for (let i = 0; i < 5; i++) {
  add(
    'plain',
    i,
    { isolated: undefined, isolationMode: undefined },
    { done: true }
  );
}
const pristine = fs.readFileSync(store.linoDbPath);
const records = store.getAll().length;

const wrapper = path.join(work, 'docker');
const callLog = path.join(work, 'calls');
fs.writeFileSync(
  wrapper,
  `#!/bin/sh\necho "$*" >> "${callLog}"\nexec docker "$@"\n`,
  { mode: 0o755 }
);

function stable(output) {
  return output
    .replace(/"currentTime":\s*"[^"]*",?/g, '')
    .replace(/"containerRemovedObservedAt":\s*"[^"]*",?/g, '');
}

function run(root, args, { fresh = true } = {}) {
  const home = path.join(work, 'home');
  if (fresh) {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.start-command'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.start-command/executions.lino'),
      pristine
    );
  }
  fs.rmSync(callLog, { force: true });
  const started = process.hrtime.bigint();
  const result = spawnSync(
    process.env.BUN || 'bun',
    [path.join(root, 'js/src/bin/cli.js'), ...args, '--output-format', 'json'],
    {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, START_DOCKER_BIN: wrapper },
      timeout: 120000,
    }
  );
  const wall = Number(process.hrtime.bigint() - started) / 1e9;
  const calls = fs.existsSync(callLog)
    ? fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return { wall, calls, status: result.status, output: stable(result.stdout) };
}

console.log(
  `docker ${docker('version', '-f', '{{.Server.Version}}')}, ${records} records, ${os.cpus().length} CPUs`
);
const cases = [
  ['--list', ['--list']],
  ['--status (kept container)', ['--status', uuids['kept-0']]],
  ['--status (running)', ['--status', uuids['run-0']]],
];
for (const [label, args] of cases) {
  const results = {};
  for (const [which, root] of [
    ['before', beforeRoot],
    ['after', afterRoot],
  ]) {
    const runs = [0, 1, 2].map(() => run(root, args));
    const walls = runs.map((r) => r.wall.toFixed(2)).join(' / ');
    const inspects = runs[0].calls.filter((c) => c.startsWith('inspect'));
    console.log(
      `${label.padEnd(26)} ${which.padEnd(6)} exit=${runs[0].status} wall=${walls} s, docker calls=${runs[0].calls.length} (inspect ${inspects.length})`
    );
    if (process.env.VERBOSE) {
      runs[0].calls.forEach((c) => console.log(`    docker ${c}`));
    }
    results[which] = runs[0].output;
  }
  console.log(
    `${label.padEnd(26)} same output before/after: ${results.before === results.after}`
  );
}
// A second `--status` in the same home: the JSON copy written by the first.
run(afterRoot, ['--status', uuids['kept-0']]);
const warm = [0, 1, 2].map(() =>
  run(afterRoot, ['--status', uuids['kept-0']], { fresh: false })
);
console.log(
  `--status, decoded copy present  after  wall=${warm.map((r) => r.wall.toFixed(2)).join(' / ')} s`
);
