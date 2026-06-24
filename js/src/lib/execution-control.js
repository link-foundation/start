/**
 * Detached execution control helpers.
 *
 * Maps start-command execution records back to their native isolation backend
 * controls so `--stop` and `--terminate` can target the stored session name.
 */

const { spawnSync } = require('child_process');
const {
  escapeForLinksNotation,
  formatAsNestedLinksNotation,
} = require('./output-blocks');

const ControlAction = {
  STOP: 'stop',
  TERMINATE: 'terminate',
};

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    success: !result.error && result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    error: result.error ? result.error.message : null,
  };
}

function parsePid(value) {
  const pid = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function parsePids(output) {
  return output
    .split(/\s+/)
    .map(parsePid)
    .filter((pid) => pid !== null);
}

function parseScreenPid(screenListOutput, sessionName) {
  for (const line of screenListOutput.split('\n')) {
    const firstColumn = line.trim().split(/\s+/)[0] || '';
    const match = firstColumn.match(/^(\d+)\.(.+)$/);
    if (match && match[2] === sessionName) {
      return parsePid(match[1]);
    }
  }
  return null;
}

function collectDescendantPids(rootPid, runner = runCommand) {
  const descendants = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];

  while (queue.length > 0) {
    const parentPid = queue.shift();
    const result = runner('pgrep', ['-P', String(parentPid)]);
    if (!result.success && !result.stdout) {
      continue;
    }

    for (const childPid of parsePids(result.stdout)) {
      if (seen.has(childPid)) {
        continue;
      }
      seen.add(childPid);
      descendants.push(childPid);
      queue.push(childPid);
    }
  }

  return descendants;
}

function addIfPresent(target, key, value) {
  if (value !== null && value !== undefined) {
    if (!Array.isArray(value) || value.length > 0) {
      target[key] = value;
    }
  }
}

function collectProcessIds(record, runner = runCommand) {
  if (!record) {
    return null;
  }

  const processIds = {};
  const opts = record.options || {};
  const sessionName = opts.sessionName;
  const isolated = opts.isolated;

  addIfPresent(processIds, 'wrapperPid', record.pid);

  if (!sessionName || !isolated) {
    return Object.keys(processIds).length > 0 ? processIds : null;
  }

  if (isolated === 'screen') {
    const result = runner('screen', ['-ls']);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const screenPid = parseScreenPid(output, sessionName);
    addIfPresent(processIds, 'screenPid', screenPid);
    if (screenPid) {
      addIfPresent(
        processIds,
        'commandPids',
        collectDescendantPids(screenPid, runner)
      );
    }
  } else if (isolated === 'tmux') {
    const tmuxPidResult = runner('tmux', [
      'display-message',
      '-p',
      '-t',
      sessionName,
      '#{pid}',
    ]);
    addIfPresent(processIds, 'tmuxPid', parsePid(tmuxPidResult.stdout));

    const panePidResult = runner('tmux', [
      'list-panes',
      '-t',
      sessionName,
      '-F',
      '#{pane_pid}',
    ]);
    const panePids = parsePids(panePidResult.stdout);
    addIfPresent(processIds, 'panePids', panePids);

    const commandPids = [
      ...new Set(
        panePids.flatMap((panePid) => collectDescendantPids(panePid, runner))
      ),
    ];
    addIfPresent(processIds, 'commandPids', commandPids);
  } else if (isolated === 'docker') {
    addIfPresent(processIds, 'containerId', opts.containerId);
    const result = runner('docker', [
      'inspect',
      '-f',
      '{{.Id}} {{.State.Pid}}',
      sessionName,
    ]);
    if (result.success && result.stdout.trim()) {
      const [containerId, pidValue] = result.stdout.trim().split(/\s+/);
      addIfPresent(processIds, 'containerId', containerId);
      addIfPresent(processIds, 'containerPid', parsePid(pidValue));
    }
  } else if (isolated === 'ssh') {
    addIfPresent(processIds, 'remotePid', opts.remotePid);
  }

  return Object.keys(processIds).length > 0 ? processIds : null;
}

function getControlCommand(record, action) {
  const opts = record.options || {};
  const backend = opts.isolated;
  const sessionName = opts.sessionName;

  if (!sessionName) {
    return {
      error: 'Execution record does not contain an isolation session name.',
    };
  }

  if (opts.isolationMode !== 'detached') {
    return {
      error: 'Only detached isolated executions can be stopped or terminated.',
    };
  }

  if (action === ControlAction.STOP) {
    switch (backend) {
      case 'screen':
        return {
          command: 'screen',
          args: ['-S', sessionName, '-X', 'stuff', '\x03'],
          method: 'CTRL_C',
          message: `Sent CTRL+C to detached screen session: ${sessionName}`,
        };
      case 'tmux':
        return {
          command: 'tmux',
          args: ['send-keys', '-t', sessionName, 'C-c'],
          method: 'CTRL_C',
          message: `Sent CTRL+C to detached tmux session: ${sessionName}`,
        };
      case 'docker':
        return {
          command: 'docker',
          args: ['stop', sessionName],
          method: 'DOCKER_STOP',
          message: `Requested graceful stop for detached docker container: ${sessionName}`,
        };
      default:
        return {
          error: `Stopping detached ${backend || 'unknown'} executions is not supported.`,
        };
    }
  }

  if (action === ControlAction.TERMINATE) {
    switch (backend) {
      case 'screen':
        return {
          command: 'screen',
          args: ['-S', sessionName, '-X', 'quit'],
          method: 'SCREEN_QUIT',
          message: `Terminated detached screen session: ${sessionName}`,
        };
      case 'tmux':
        return {
          command: 'tmux',
          args: ['kill-session', '-t', sessionName],
          method: 'KILL_SESSION',
          message: `Terminated detached tmux session: ${sessionName}`,
        };
      case 'docker':
        return {
          command: 'docker',
          args: ['kill', sessionName],
          method: 'SIGKILL',
          message: `Terminated detached docker container: ${sessionName}`,
        };
      default:
        return {
          error: `Terminating detached ${backend || 'unknown'} executions is not supported.`,
        };
    }
  }

  return { error: `Unknown control action: ${action}` };
}

function formatControlResultAsLinksNotation(result) {
  const lines = [
    'executionControl',
    `  action ${escapeForLinksNotation(result.action)}`,
    `  identifier ${escapeForLinksNotation(result.identifier)}`,
    `  uuid ${escapeForLinksNotation(result.uuid)}`,
    `  status ${escapeForLinksNotation(result.status)}`,
    `  backend ${escapeForLinksNotation(result.backend)}`,
    `  sessionName ${escapeForLinksNotation(result.sessionName)}`,
    `  method ${escapeForLinksNotation(result.method)}`,
  ];

  if (result.processIds) {
    lines.push('  processIds');
    lines.push(formatAsNestedLinksNotation(result.processIds, 2, 2));
  }

  lines.push(`  message ${escapeForLinksNotation(result.message)}`);
  return lines.join('\n');
}

function controlExecution(store, identifier, action, runner = runCommand) {
  if (!store) {
    return { success: false, error: 'Execution tracking is disabled.' };
  }

  const record = store.get(identifier);
  if (!record) {
    return {
      success: false,
      error: `No execution found with UUID or session name: ${identifier}`,
    };
  }

  const control = getControlCommand(record, action);
  if (control.error) {
    return { success: false, error: control.error };
  }

  const result = runner(control.command, control.args);
  if (!result.success) {
    const detail =
      result.stderr || result.error || `exit code ${result.status}`;
    return {
      success: false,
      error: `Failed to ${action} ${record.options.isolated} session "${record.options.sessionName}": ${detail}`,
    };
  }

  const output = formatControlResultAsLinksNotation({
    action,
    identifier,
    uuid: record.uuid,
    status: action === ControlAction.STOP ? 'signal-sent' : 'terminated',
    backend: record.options.isolated,
    sessionName: record.options.sessionName,
    method: control.method,
    processIds: collectProcessIds(record, runner),
    message: control.message,
  });

  return { success: true, output };
}

module.exports = {
  ControlAction,
  collectDescendantPids,
  collectProcessIds,
  controlExecution,
  formatControlResultAsLinksNotation,
  getControlCommand,
  parseScreenPid,
  runCommand,
};
