// Real-daemon check for issue #244: what `docker run --init` (Docker's bundled
// tini as PID 1) changes and what it keeps.
//   1. zombies: an orphaned grandchild is reaped with --init, left as a zombie
//      without it;
//   2. exit evidence: `exit 3`, a child killed by SIGSEGV, a memory-limit OOM
//      kill and `docker kill` give the same ExitCode / OOMKilled with and
//      without --init;
//   3. `docker stop`: tini forwards SIGTERM, so a command without a handler
//      ends with 143 at once instead of 137 after the grace period.
//
// Usage: node experiments/issue-244-tini-exit-evidence.js
// Bounded: every container sleeps 30 s at most, uses --memory 32m in the OOM
// case, and is removed on exit.
const { spawnSync } = require('child_process');

const image = process.env.IMAGE || 'alpine:3.23';
const tag = `t244-${process.pid}`;
const names = [];
function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: r.stderr };
}
process.on('exit', () => {
  if (names.length) {
    spawnSync('docker', ['rm', '-f', ...names], { stdio: 'ignore' });
  }
});
function run(label, init, extra, cmd) {
  const name = `${tag}-${label}-${init ? 'init' : 'plain'}`;
  names.push(name);
  const r = docker(
    'run',
    '-d',
    '--name',
    name,
    ...(init ? ['--init'] : []),
    ...extra,
    image,
    'sh',
    '-c',
    cmd
  );
  if (r.status !== 0) {
    // Some daemons (rootless, nested cgroup v2 in threaded mode) cannot
    // apply --memory; report that instead of a result.
    return { failed: r.err.trim().split('\n')[0] };
  }
  return name;
}
function state(name) {
  if (name.failed) {
    return `skipped: ${name.failed}`;
  }
  docker('wait', name);
  const [code, oom] = docker(
    'inspect',
    '-f',
    '{{.State.ExitCode}} {{.State.OOMKilled}}',
    name
  ).out.split(' ');
  return `exit=${code} oom=${oom}`;
}
function waitMs(ms) {
  spawnSync('sleep', [String(ms / 1000)]);
}

console.log(`docker ${docker('version', '-f', '{{.Server.Version}}').out}`);
for (const init of [false, true]) {
  const label = init ? '--init' : 'no init';
  // 1. An orphan: the subshell exits at once, its `sleep 0.2` child is
  //    re-parented to PID 1 and exits 0.2 s later.
  const z = run('zombie', init, [], '(sleep 0.2 &) ; exec sleep 30');
  waitMs(1500);
  const zombies = docker(
    'exec',
    z,
    'sh',
    '-c',
    'grep -l "^State:.*Z" /proc/[0-9]*/status 2>/dev/null | wc -l'
  ).out;
  const pid1 = docker('exec', z, 'cat', '/proc/1/comm').out;
  console.log(`${label.padEnd(8)} PID 1=${pid1.padEnd(11)} zombies=${zombies}`);

  // 2. Exit evidence.
  const cases = [
    ['exit3', [], 'exit 3'],
    ['segv', [], 'sh -c "kill -SEGV \\$\\$"; exit $?'],
    ['oom', ['--memory', '32m', '--memory-swap', '32m'], 'tail /dev/zero'],
  ];
  for (const [what, extra, cmd] of cases) {
    console.log(
      `${label.padEnd(8)} ${what.padEnd(6)} ${state(run(what, init, extra, cmd))}`
    );
  }
  const k = run('kill', init, [], 'sleep 30');
  waitMs(500);
  docker('kill', k);
  console.log(`${label.padEnd(8)} ${'kill'.padEnd(6)} ${state(k)}`);

  // 3. docker stop with a 2 s grace period.
  const s = run('stop', init, [], 'sleep 30');
  waitMs(500);
  const started = Date.now();
  docker('stop', '-t', '2', s);
  const took = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${label.padEnd(8)} ${'stop'.padEnd(6)} ${state(s)} after ${took} s`
  );
}
