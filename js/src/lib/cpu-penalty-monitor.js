/** A watcher-owned monitor. Sidecars avoid writing the store for every sample. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { initialState, evaluate } = require('./cpu-penalty');
const { LockManager } = require('./store-lock');
const { shellQuote } = require('./isolation-log-utils');
const { cpuCount, cpuUpdateArgs } = require('./docker-resource-limits');
function statePath(record) {
  return `${record.logPath}.cpu-penalty.json`;
}
function readState(record) {
  if (!record.options?.cpuPenaltyConfig || !record.logPath) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath(record), 'utf8'));
    if (
      state.containerName !== record.options.sessionName ||
      state.attemptNumber !== (record.attempt?.number || 1)
    ) {
      return null;
    }
    if (state.phase === 'penalized' && Number.isFinite(state.updatedAt)) {
      const until = record.endTime ? Date.parse(record.endTime) : Date.now();
      state.penalizedMs += Math.max(0, until - state.updatedAt);
      state.updatedAt = Math.max(until, state.updatedAt);
    }
    return state;
  } catch {
    return null;
  }
}
function publicState(state) {
  const result = { ...state };
  delete result.samples;
  delete result.lastAt;
  delete result.capacity;
  return result;
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { success: result.status === 0, stdout: result.stdout || '' };
}
async function monitor(uuid, name, attemptNumber, standalone) {
  const { ExecutionStore } = require('./execution-store');
  const store = uuid
    ? new ExecutionStore(
        process.env.START_APP_FOLDER
          ? { appFolder: path.resolve(process.env.START_APP_FOLDER) }
          : {}
      )
    : null;
  const record = store ? store.get(uuid) : JSON.parse(standalone || 'null');
  if (
    !record?.options.cpuPenaltyConfig ||
    !record.logPath ||
    record.options.sessionName !== name
  ) {
    return;
  }
  const config = record.options.cpuPenaltyConfig;
  const lock = new LockManager(`${statePath(record)}.lock`);
  if (!lock.acquire(100)) {
    return;
  }
  const docker = require('./docker-cleanup').getDockerCommand();
  const baseFlags =
    record.options.baseResourceLimits || record.options.resourceLimits || [];
  const baseCpus = cpuCount(baseFlags);
  let state = initialState(baseCpus, Date.now(), readState(record));
  const interval = Math.min(
    30000,
    Math.max(50, Math.min(config.triggerWindowMs, config.releaseWindowMs) / 8)
  );
  const publish = () => {
    const file = statePath(record),
      tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          ...publicState(state),
          containerName: name,
          attemptNumber: Number(attemptNumber),
          updatedAt: Date.now(),
        })
      );
      fs.renameSync(tmp, file);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* Optional diagnostics are best effort. */
      }
    }
  };
  const log = (text) => {
    try {
      fs.appendFileSync(record.logPath, `${text}\n`);
    } catch {
      /* Optional diagnostics are best effort. */
    }
  };
  const started = Date.now();
  try {
    publish();
    while (true) {
      const current = store ? store.get(uuid) : record;
      if (
        !current ||
        current.options.sessionName !== name ||
        (current.attempt?.number || 1) !== Number(attemptNumber)
      ) {
        break;
      }
      const live = run(docker, ['inspect', '-f', '{{.State.Running}}', name]);
      if (live.success && live.stdout.trim() === 'false') {
        break;
      }
      if (!live.success && Date.now() - started > 30000) {
        break;
      }
      const info = run(docker, ['info', '--format', '{{json .}}']);
      const stats = run(docker, [
        'stats',
        '--no-stream',
        '--format',
        '{{json .}}',
      ]);
      let daemonCpus = NaN,
        cores = NaN;
      try {
        if (info.success) {
          daemonCpus = JSON.parse(info.stdout).NCPU;
        }
        if (stats.success) {
          const row = stats.stdout
            .trim()
            .split('\n')
            .map((s) => JSON.parse(s))
            .find((s) => s.Name === name);
          if (row && /^\d+(?:\.\d+)?%$/.test(row.CPUPerc)) {
            cores = Number(row.CPUPerc.slice(0, -1)) / 100;
          }
        }
      } catch {
        /* Optional diagnostics are best effort. */
      }
      const decision = evaluate(
        state,
        {
          now: Date.now(),
          cores,
          daemonCpus,
          maxGapMs: Math.max(5000, interval * 3),
        },
        config
      );
      if (decision.action) {
        const action = decision.action;
        const update = run(docker, [
          'update',
          ...cpuUpdateArgs(baseFlags, action.cpus),
          name,
        ]);
        if (update.success) {
          state = decision.state;
          log(
            `[start] CPU penalty ${action.kind === 'apply' ? 'applied' : 'lifted'}: ${action.cpus} CPUs (${action.average === null || action.average === undefined ? 'capacity changed' : `${action.average.toFixed(2)} of ${action.capacity} CPUs`})`
          );
        } else {
          state = {
            ...decision.state,
            phase: state.phase,
            since: state.since,
            limitCpus: state.limitCpus,
            penaltyCount: state.penaltyCount,
            samples: [],
          };
        }
      } else {
        state = decision.state;
      }
      publish();
      await new Promise((resolve) => globalThis.setTimeout(resolve, interval));
    }
  } finally {
    lock.release();
  }
}
function startSnippet(uuid, name, attempt = 1, options = null) {
  const standalone =
    !uuid && options?.cpuPenaltyConfig && options.logPath
      ? JSON.stringify({
          logPath: options.logPath,
          options: {
            sessionName: name,
            cpuPenaltyConfig: options.cpuPenaltyConfig,
            baseResourceLimits: options.resourceLimits,
          },
        })
      : null;
  if (!uuid && !standalone) {
    return '';
  }
  return `${shellQuote(process.execPath)} ${shellQuote(__filename)} ${shellQuote(uuid || '')} ${shellQuote(name)} ${Number(attempt)} ${shellQuote(standalone || '')} >/dev/null 2>&1 & __start_cpu_monitor=$!`;
}
function stopSnippet() {
  return 'if [ -n "$__start_cpu_monitor" ]; then kill "$__start_cpu_monitor" 2>/dev/null; wait "$__start_cpu_monitor" 2>/dev/null; fi';
}
module.exports = {
  statePath,
  readState,
  publicState,
  monitor,
  startSnippet,
  stopSnippet,
};
if (require.main === module) {
  monitor(...process.argv.slice(2)).catch((error) => {
    if (process.env.START_DEBUG === '1') {
      console.error(`[DEBUG] CPU monitor: ${error.stack}`);
    }
  });
}
