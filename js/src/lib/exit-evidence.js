/** Attempt-scoped evidence, independent of Docker's sticky OOMKilled flag. */
const { spawnSync } = require('child_process');
const { shellQuote } = require('./isolation-log-utils');
const MAIN_OOM = 'Exit evidence: main-oom (recent cgroup oom_kill delta)';
const DOCKER_OOM = 'Exit evidence: main-oom (recent Docker oom event)';
const DAEMON_RESTART =
  'Exit evidence: docker-daemon-restart (Docker service journal)';
const DAEMON_RESTART_API =
  'Exit evidence: docker-daemon-restart (Docker API: containers finished together)';
const DAEMON_RESTART_PREFIX = 'Exit evidence: docker-daemon-restart';
// dockerd gives every container its stop timeout and kills the rest within its
// 15 s shutdown timeout, so the containers of one restart finish this close.
const DAEMON_RESTART_WINDOW_MS = 15000;
const CONTAINER_STATE_FORMAT =
  '{{.Id}} {{.State.FinishedAt}} {{.State.StartedAt}} {{.State.ExitCode}} {{.State.OOMKilled}}';
// Bounds one `docker inspect` call on hosts with many stopped containers.
const MAX_PEER_CONTAINERS = 256;

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

/**
 * Socket-only daemon-restart evidence (issue #241): another container that
 * finished within the same shutdown window, was not OOM-killed, and was either
 * stopped by a signal (137/143) or started again afterwards (restart policy;
 * moby resets its ExitCode to 0 but keeps FinishedAt). `docker events` cannot
 * be used: its buffer does not survive the restart, while State does.
 * @param {string} states - `CONTAINER_STATE_FORMAT` lines, one per container
 */
function daemonRestartApiEvidence(states, containerId, finishedAt) {
  const finished = Date.parse(finishedAt);
  return (
    Number.isFinite(finished) &&
    String(states || '')
      .split('\n')
      .some((line) => {
        const [id, peerFinished, peerStarted, exit, oom] = line
          .trim()
          .split(/\s+/);
        const end = Date.parse(peerFinished);
        if (
          !/^[a-f0-9]{64}$/.test(id || '') ||
          id === containerId ||
          oom !== 'false' ||
          !Number.isFinite(end) ||
          end <= 0 ||
          Math.abs(end - finished) > DAEMON_RESTART_WINDOW_MS
        ) {
          return false;
        }
        return (
          exit === '137' || exit === '143' || Date.parse(peerStarted) > end
        );
      })
  );
}

function recentDockerOom(events, finishedAt) {
  const finished = Date.parse(finishedAt) / 1000;
  return (
    Number.isFinite(finished) &&
    String(events || '')
      .split('\n')
      .some((line) => {
        if (!/^\d+$/.test(line.trim())) {
          return false;
        }
        const at = Number(line.trim());
        return at > 0 && finished - at >= -1 && finished - at <= 3;
      })
  );
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
  const sampledOom =
    (oomKilled === true || oomKilled === 'true') &&
    (Number(exitCode) === 137 || Number(exitCode) < 0) &&
    recentOomDelta(sample, finishedAt);
  if (
    Number(exitCode) === 137 &&
    containerName &&
    Number.isFinite(Date.parse(finishedAt))
  ) {
    const docker = require('./docker-cleanup').getDockerCommand();
    const id = run(docker, ['inspect', '-f', '{{.Id}}', containerName]);
    if (id.success && /^[a-f0-9]{64}$/.test(id.stdout.trim())) {
      const end = Date.parse(finishedAt);
      const journal = local
        ? run('journalctl', [
            '-u',
            'docker.service',
            '--since',
            new Date(end - 60000).toISOString(),
            '--until',
            new Date(end + 1000).toISOString(),
            '--no-pager',
            '-o',
            'cat',
          ])
        : { success: false, stdout: '' };
      if (
        journal.success &&
        daemonRestartEvidence(journal.stdout, id.stdout.trim())
      ) {
        return DAEMON_RESTART;
      }
      // Query the daemon's bounded event history: works with DooD and remote
      // sockets even after the final kill destroys the sampled cgroup.
      const events = run(docker, [
        'events',
        '--since',
        new Date(end - 60000).toISOString(),
        '--until',
        new Date(end + 1000).toISOString(),
        '--filter',
        `container=${id.stdout.trim()}`,
        '--filter',
        'event=oom',
        '--format',
        '{{.Time}}',
      ]);
      if (events.success && recentDockerOom(events.stdout, finishedAt)) {
        return DOCKER_OOM;
      }
      // Without a host journal (a mounted docker.sock, a remote daemon) the
      // only record of the restart is the state of the other containers.
      const peers = sampledOom
        ? { success: false, stdout: '' }
        : run(docker, ['ps', '-a', '-q', '--no-trunc']);
      const ids = peers.stdout
        .split(/\s+/)
        .filter(
          (peer) => /^[a-f0-9]{64}$/.test(peer) && peer !== id.stdout.trim()
        )
        .slice(0, MAX_PEER_CONTAINERS);
      // A container removed after `docker ps` fails inspect with status 1 but
      // the others are still printed, so the output is used either way.
      const states = ids.length
        ? run(docker, ['inspect', '-f', CONTAINER_STATE_FORMAT, ...ids])
        : { success: false, stdout: '' };
      if (
        daemonRestartApiEvidence(states.stdout, id.stdout.trim(), finishedAt)
      ) {
        return DAEMON_RESTART_API;
      }
      if (process.env.START_DEBUG === '1') {
        console.error(
          `[DEBUG] Exit evidence: container=${id.stdout.trim()} finishedAt=${finishedAt} eventsAvailable=${events.success} oomEvents=${JSON.stringify(events.stdout)} peerContainers=${ids.length} peerStates=${JSON.stringify(states.stdout)} sample=${JSON.stringify(sample || '')}`
        );
      }
    }
  }
  if (sampledOom) {
    return MAIN_OOM;
  }
  return 'Exit evidence: unavailable (no attributed exit-time OOM or daemon restart evidence)';
}

function fromLog(log) {
  const lines = String(log || '').split('\n');
  const last = lines.filter((line) => line.startsWith('Exit evidence:')).at(-1);
  const daemonRestart = Boolean(last?.startsWith(DAEMON_RESTART_PREFIX));
  return {
    mainOom: last === MAIN_OOM || last === DOCKER_OOM,
    daemonRestart,
    // Which source attributed the restart: the host journal or the API.
    ...(daemonRestart
      ? { daemonRestartSource: last === DAEMON_RESTART_API ? 'api' : 'journal' }
      : {}),
  };
}

/** The stored `daemonRestartSource`, kept only when a restart was attributed. */
function sourceOf(logged) {
  return logged?.daemonRestart && logged.daemonRestartSource
    ? { daemonRestartSource: logged.daemonRestartSource }
    : {};
}

// A watcher that shares the daemon with its task (a mounted docker.sock) dies
// in the same restart and never logs evidence, so `--status` collects it from
// the container state that survived, once per process (issue #241).
const lostWatcherEvidence = new Map();
function collectLostWatcherEvidence(record, state, runner) {
  const name = record?.options?.sessionName;
  if (
    !name ||
    record.options.exitEvidence ||
    state?.running !== false ||
    state.exitCode !== 137 ||
    !state.finishedAt
  ) {
    return null;
  }
  const key = `${name}\0${state.finishedAt}`;
  if (!lostWatcherEvidence.has(key)) {
    const logged = fromLog(
      collectExitEvidence(
        {
          containerName: name,
          finishedAt: state.finishedAt,
          exitCode: state.exitCode,
          oomKilled: state.oomKilled,
        },
        runner
      )
    );
    lostWatcherEvidence.set(key, {
      mainOom: logged.mainOom,
      daemonRestart: logged.daemonRestart,
      ...sourceOf(logged),
    });
  }
  return { ...lostWatcherEvidence.get(key) };
}

/** Stores the lost watcher's evidence when the log tail carries none. */
function addLostWatcherEvidence(enriched, record, state, logTail) {
  const lost =
    state && !/^Exit evidence:/m.test(logTail || '')
      ? collectLostWatcherEvidence(record, state)
      : null;
  if (lost) {
    enriched.options = { ...enriched.options, exitEvidence: lost };
  }
}

function buildExitEvidenceSnippet(containerName, quotedLogPath) {
  const stderr = process.env.START_DEBUG === '1' ? '2>&1' : '2>/dev/null';
  return `${shellQuote(process.execPath)} ${shellQuote(__filename)} ${shellQuote(containerName)} "$__start_command_cgroup" "$__start_command_finished" "$__start_command_exit" "$__start_command_oom" >> ${quotedLogPath} ${stderr}`;
}

module.exports = {
  MAIN_OOM,
  DOCKER_OOM,
  DAEMON_RESTART,
  DAEMON_RESTART_API,
  recentOomDelta,
  daemonRestartApiEvidence,
  recentDockerOom,
  daemonRestartEvidence,
  collectExitEvidence,
  fromLog,
  sourceOf,
  collectLostWatcherEvidence,
  addLostWatcherEvidence,
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
