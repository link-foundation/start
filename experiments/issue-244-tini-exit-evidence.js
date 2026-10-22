// Real-daemon check for issue #244: what `docker run --init` (Docker's bundled
// tini as PID 1) changes and what it keeps.
//   1. zombies: an orphaned grandchild is reaped with --init, left as a zombie
//      without it;
//   2. exit evidence: `exit 3`, a child killed by SIGSEGV, a memory-limit OOM
//      kill and `docker kill` give the same ExitCode / OOMKilled with and
//      without --init. The OOM kill also goes through the exit-time evidence
//      and exit-reason code (`collectExitEvidence`, `resolveExitReason`), so
//      both runs must be attributed to the cgroup OOM killer;
//   3. `docker stop`: tini forwards SIGTERM, so a command without a handler
//      ends with 143 at once instead of 137 after the grace period.
//
// Usage: node experiments/issue-244-tini-exit-evidence.js
// Exits 1 when a result differs from the expectation above. A daemon that
// cannot apply --memory (rootless, nested cgroup v2 in threaded mode) reports
// the OOM case as skipped instead, unless ISSUE_244_REQUIRE_OOM=1 (CI).
// Bounded: every container sleeps 30 s at most, uses --memory 32m in the OOM
// case, and is removed on exit.
const { spawnSync } = require('child_process');
const { collectExitEvidence, recentDockerOom } = require('../js/src/lib/exit-evidence');
const {
  resolveExitReason,
  resolveMemoryExhaustion,
} = require('../js/src/lib/exit-reason');

const image = process.env.IMAGE || 'alpine:3.23';
const tag = `t244-${process.pid}`;
const names = [];
const failures = [];
function docker(...args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: r.stderr };
}
process.on('exit', () => {
  if (names.length) {
    spawnSync('docker', ['rm', '-f', ...names], { stdio: 'ignore' });
  }
});
function expect(label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label}: got ${actual}, expected ${expected}`);
  }
}
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
    return { failed: r.err.trim().split('\n')[0] };
  }
  return name;
}
function finalState(name) {
  docker('wait', name);
  const [exitCode, oomKilled, finishedAt] = docker(
    'inspect',
    '-f',
    '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.FinishedAt}}',
    name
  ).out.split(' ');
  return { exitCode: Number(exitCode), oomKilled: oomKilled === 'true', finishedAt };
}
/** The exit reason `$` would store for this container. */
function attribute(name, state) {
  const commands = [];
  const line = collectExitEvidence(
    { containerName: name, ...state },
    (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      commands.push({ args, stdout: r.stdout });
      return { success: r.status === 0, stdout: r.stdout || '' };
    }
  );
  const input = { exitCode: state.exitCode, oomKilled: state.oomKilled, logTail: line };
  const events = commands.find(({ args }) => args[0] === 'events');
  return {
    reason: resolveExitReason(input),
    memory: Boolean(resolveMemoryExhaustion(input)),
    oomEvent: recentDockerOom(events && events.stdout, state.finishedAt),
  };
}
function waitMs(ms) {
  spawnSync('sleep', [String(ms / 1000)]);
}

console.log(`docker ${docker('version', '-f', '{{.Server.Version}}').out}`);
const results = { false: {}, true: {} };
for (const init of [false, true]) {
  const label = init ? '--init' : 'no init';
  const row = results[init];
  // 1. An orphan: the subshell exits at once, its `sleep 0.2` child is
  //    re-parented to PID 1 and exits 0.2 s later.
  const z = run('zombie', init, [], '(sleep 0.2 &) ; exec sleep 30');
  waitMs(1500);
  row.zombies = docker(
    'exec',
    z,
    'sh',
    '-c',
    'grep -l "^State:.*Z" /proc/[0-9]*/status 2>/dev/null | wc -l'
  ).out;
  row.pid1 = docker('exec', z, 'cat', '/proc/1/comm').out;
  console.log(`${label.padEnd(8)} PID 1=${row.pid1.padEnd(11)} zombies=${row.zombies}`);

  // 2. Exit evidence.
  const cases = [
    ['exit3', [], 'exit 3'],
    ['segv', [], 'sh -c "kill -SEGV \\$\\$"; exit $?'],
  ];
  for (const [what, extra, cmd] of cases) {
    const s = finalState(run(what, init, extra, cmd));
    row[what] = `exit=${s.exitCode} oom=${s.oomKilled}`;
    console.log(`${label.padEnd(8)} ${what.padEnd(6)} ${row[what]}`);
  }
  // Docker occasionally publishes no `oom` event for the final kill (see
  // experiments/issue-209-docker.mjs); retry only that missing-input case.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const name = run(
      `oom${attempt}`,
      init,
      ['--memory', '32m', '--memory-swap', '32m'],
      'tail /dev/zero'
    );
    if (name.failed) {
      row.oom = `skipped: ${name.failed}`;
      break;
    }
    const s = finalState(name);
    const a = attribute(name, s);
    row.oom = `exit=${s.exitCode} oom=${s.oomKilled} reason=${a.reason} memoryExhausted=${a.memory}`;
    if (a.oomEvent || attempt === 3) {
      break;
    }
  }
  console.log(`${label.padEnd(8)} ${'oom'.padEnd(6)} ${row.oom}`);
  const k = run('kill', init, [], 'sleep 30');
  waitMs(500);
  docker('kill', k);
  const killed = finalState(k);
  row.kill = `exit=${killed.exitCode} oom=${killed.oomKilled}`;
  console.log(`${label.padEnd(8)} ${'kill'.padEnd(6)} ${row.kill}`);

  // 3. docker stop with a 2 s grace period.
  const s = run('stop', init, [], 'sleep 30');
  waitMs(500);
  const started = Date.now();
  docker('stop', '-t', '2', s);
  const took = (Date.now() - started) / 1000;
  const stopped = finalState(s);
  row.stop = `exit=${stopped.exitCode} oom=${stopped.oomKilled}`;
  row.stopSeconds = took;
  console.log(`${label.padEnd(8)} ${'stop'.padEnd(6)} ${row.stop} after ${took.toFixed(1)} s`);
}

const [plain, init] = [results.false, results.true];
expect('--init PID 1', init.pid1, 'docker-init');
expect('--init zombies', init.zombies, '0');
expect('no init zombies', plain.zombies, '1');
for (const what of ['exit3', 'segv', 'kill']) {
  expect(`${what} with --init`, init[what], plain[what]);
}
expect('exit3', plain.exit3, 'exit=3 oom=false');
expect('segv', plain.segv, 'exit=139 oom=false');
expect('kill', plain.kill, 'exit=137 oom=false');
const oomSkipped =
  plain.oom.startsWith('skipped') && init.oom.startsWith('skipped');
if (oomSkipped && process.env.ISSUE_244_REQUIRE_OOM === '1') {
  failures.push('oom: skipped, but ISSUE_244_REQUIRE_OOM=1 requires it');
}
if (!oomSkipped) {
  const oom =
    'exit=137 oom=true reason=memory-exhaustion (cgroup-oom-killer) memoryExhausted=true';
  expect('oom without --init', plain.oom, oom);
  expect('oom with --init', init.oom, oom);
}
expect('stop without --init', plain.stop, 'exit=137 oom=false');
expect('stop with --init', init.stop, 'exit=143 oom=false');
if (failures.length) {
  console.error(`FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('OK: --init reaps orphans and keeps exit evidence');
