/** Attempt-scoped evidence, independent of Docker's sticky OOMKilled flag. */
const { spawnSync } = require('child_process');
const { shellQuote } = require('./isolation-log-utils');
const MAIN_OOM = 'Exit evidence: main-oom (recent cgroup oom_kill delta)';
const DAEMON_RESTART =
  'Exit evidence: docker-daemon-restart (Docker service journal)';

function recentOomDelta(sample, finishedAt) {
  const fields = String(sample || '')
    .trim()
    .split(/\s+/);
  const changed = Number(fields[4]),
    observed = Number(fields[5]);
  const finished = Date.parse(finishedAt) / 1000;
  return (
    changed > 0 &&
    Number.isFinite(finished) &&
    changed <= observed &&
    Math.abs(finished - changed) <= 3 &&
    Math.abs(finished - observed) <= 3
  );
}

function daemonRestartEvidence(journal, containerId) {
  const lines = String(journal || '').split('\n');
  const exited = lines.some((line) =>
    /Main process exited|Stopping Docker|Starting Docker|Daemon shutdown complete/.test(
      line
    )
  );
  const forced =
    containerId &&
    lines.some(
      (line) =>
        line.includes(containerId) &&
        /failed to exit|using the force|force.kill/i.test(line)
    );
  return Boolean(exited && forced);
}

function collectExitEvidence(
  { containerName, sample, finishedAt, exitCode, oomKilled },
  runner
) {
  const run =
    runner ||
    ((cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      return { success: r.status === 0, stdout: r.stdout || '' };
    });
  // A local journal cannot diagnose a remote daemon. Require a local socket.
  const local =
    !process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith('unix://');
  if (
    local &&
    Number(exitCode) === 137 &&
    Number.isFinite(Date.parse(finishedAt))
  ) {
    const docker = require('./docker-cleanup').getDockerCommand();
    const id = run(docker, ['inspect', '-f', '{{.Id}}', containerName]);
    if (id.success && /^[a-f0-9]{64}$/.test(id.stdout.trim())) {
      const end = Date.parse(finishedAt);
      const journal = run('journalctl', [
        '-u',
        'docker.service',
        '--since',
        new Date(end - 60000).toISOString(),
        '--until',
        new Date(end + 1000).toISOString(),
        '--no-pager',
        '-o',
        'cat',
      ]);
      if (
        journal.success &&
        daemonRestartEvidence(journal.stdout, id.stdout.trim())
      ) {
        return DAEMON_RESTART;
      }
    }
  }
  if (
    (oomKilled === true || oomKilled === 'true') &&
    (Number(exitCode) === 137 || Number(exitCode) < 0) &&
    recentOomDelta(sample, finishedAt)
  ) {
    return MAIN_OOM;
  }
  return 'Exit evidence: unavailable (no attributed exit-time OOM or daemon restart evidence)';
}

function fromLog(log) {
  const lines = String(log || '').split('\n');
  const last = lines.filter((line) => line.startsWith('Exit evidence:')).at(-1);
  return { mainOom: last === MAIN_OOM, daemonRestart: last === DAEMON_RESTART };
}

function buildExitEvidenceSnippet(containerName, quotedLogPath) {
  return `${shellQuote(process.execPath)} ${shellQuote(__filename)} ${shellQuote(containerName)} "$__start_command_cgroup" "$__start_command_finished" "$__start_command_exit" "$__start_command_oom" >> ${quotedLogPath} 2>/dev/null`;
}

module.exports = {
  MAIN_OOM,
  DAEMON_RESTART,
  recentOomDelta,
  daemonRestartEvidence,
  collectExitEvidence,
  fromLog,
  buildExitEvidenceSnippet,
};
if (require.main === module) {
  const [containerName, sample, finishedAt, exitCode, oomKilled] =
    process.argv.slice(2);
  console.log(
    collectExitEvidence({
      containerName,
      sample,
      finishedAt,
      exitCode,
      oomKilled,
    })
  );
}
