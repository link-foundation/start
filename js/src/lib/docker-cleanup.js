const { spawn, spawnSync } = require('child_process');
const {
  appendLogFile,
  createShellLogFooterSnippet,
  shellQuote,
} = require('./isolation-log-utils');

const DOCKER_CONTAINER_CLEANUP_POLICY = {
  DEFAULT: 'default',
  ALWAYS: 'always',
  KEEP: 'keep',
  KEEP_ON_FAIL: 'keep-on-fail',
};

function getDockerContainerCleanupPolicy(options = {}) {
  if (options.keepContainer) {
    return DOCKER_CONTAINER_CLEANUP_POLICY.KEEP;
  }
  if (options.keepContainerOnFail) {
    return DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL;
  }
  if (options.alwaysCleanupContainer || options.autoRemoveDockerContainer) {
    return DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS;
  }
  return DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT;
}

function isAbnormalDockerExit(exitCode, oomKilled = false) {
  return exitCode !== 0 || oomKilled === true;
}

function shouldCleanupDockerContainer(policy, exitCode, oomKilled = false) {
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
    return true;
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT) {
    return !isAbnormalDockerExit(exitCode, oomKilled);
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL) {
    return !isAbnormalDockerExit(exitCode, oomKilled);
  }
  return false;
}

function getDockerContainerCleanupInstructions(containerName) {
  return [
    `Container kept for investigation: ${containerName}`,
    `Inspect: docker exec -it ${containerName} sh (if running) or docker start -ai ${containerName}`,
    `Remove when done: docker rm -f ${containerName}`,
  ].join('\n');
}

function appendDockerContainerCleanupPolicyMessage(
  message,
  containerName,
  policy
) {
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP) {
    return `${message}\n${getDockerContainerCleanupInstructions(containerName)}`;
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL) {
    return (
      `${message}\nContainer will be removed after successful completion.` +
      `\nContainer will be kept if the command fails or Docker reports OOMKilled.` +
      `\nRemove when done: docker rm -f ${containerName}`
    );
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT) {
    return (
      `${message}\nContainer will be removed after successful completion.` +
      `\nContainer will be kept if the command fails or Docker reports OOMKilled.` +
      `\nRemove when done: docker rm -f ${containerName}`
    );
  }
  return `${message}\nContainer will be removed after command completes.`;
}

function readDockerContainerOomKilled(containerName) {
  const result = spawnSync(
    'docker',
    ['inspect', '-f', '{{.State.OOMKilled}}', containerName],
    {
      encoding: 'utf8',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  if (result.error || result.status !== 0) {
    return null;
  }
  const value = String(result.stdout || '').trim();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

function removeDockerContainer(containerName, logPath = null) {
  const result = spawnSync('docker', ['rm', '-f', containerName], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (logPath && output) {
    appendLogFile(logPath, output.endsWith('\n') ? output : `${output}\n`);
  }
  return !result.error && result.status === 0;
}

function buildDockerKeptLogSnippet(containerName, quotedLogPath) {
  const quotedName = shellQuote(containerName);
  return (
    `printf '\\nContainer kept for investigation: %s\\nReason: exitCode=%s oomKilled=%s\\n` +
    `Inspect: docker exec -it %s sh (if running) or docker start -ai %s\\n` +
    `Remove when done: docker rm -f %s\\n' ` +
    `${quotedName} "$__start_command_exit" "$__start_command_oom" ` +
    `${quotedName} ${quotedName} ${quotedName} >> ${quotedLogPath}`
  );
}

function buildSuccessfulNonOomCondition() {
  return (
    '[ "$__start_command_exit" -eq 0 ] 2>/dev/null && ' +
    '[ "$__start_command_oom" != true ]'
  );
}

function buildDetachedDockerCompletionScript(containerName, policy, logPath) {
  const quotedName = shellQuote(containerName);
  const parts = [];

  if (logPath) {
    const quotedLogPath = shellQuote(logPath);
    parts.push(`docker logs -f ${quotedName} >> ${quotedLogPath} 2>&1`);
    parts.push(
      `__start_command_state=$(docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' ${quotedName} 2>/dev/null || printf '%s' '-1 false')`
    );
    parts.push('__start_command_exit=${__start_command_state%% *}');
    parts.push('__start_command_oom=${__start_command_state##* }');
    if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
      parts.push(`docker rm -f ${quotedName} >> ${quotedLogPath} 2>&1 || true`);
    } else if (
      policy === DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT ||
      policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL
    ) {
      const successCondition = buildSuccessfulNonOomCondition();
      parts.push(
        `if ${successCondition}; then docker rm -f ${quotedName} >> ${quotedLogPath} 2>&1 || true; else ${buildDockerKeptLogSnippet(containerName, quotedLogPath)}; fi`
      );
    }
    parts.push(`${createShellLogFooterSnippet()} >> ${quotedLogPath}`);
  } else {
    parts.push(`docker wait ${quotedName} >/dev/null 2>&1`);
    parts.push(
      `__start_command_state=$(docker inspect -f '{{.State.ExitCode}} {{.State.OOMKilled}}' ${quotedName} 2>/dev/null || printf '%s' '-1 false')`
    );
    parts.push('__start_command_exit=${__start_command_state%% *}');
    parts.push('__start_command_oom=${__start_command_state##* }');
    if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
      parts.push(`docker rm -f ${quotedName} >/dev/null 2>&1 || true`);
    } else if (
      policy === DOCKER_CONTAINER_CLEANUP_POLICY.DEFAULT ||
      policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL
    ) {
      parts.push(
        `if ${buildSuccessfulNonOomCondition()}; then docker rm -f ${quotedName} >/dev/null 2>&1 || true; fi`
      );
    }
  }

  return parts.join('; ');
}

function startDetachedDockerCompletionWatcher(containerName, policy, logPath) {
  const watcher = spawn(
    'sh',
    ['-c', buildDetachedDockerCompletionScript(containerName, policy, logPath)],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  watcher.unref();
}

function spawnAttachedDocker(dockerArgs, logPath) {
  if (!logPath) {
    return spawn('docker', dockerArgs, { stdio: 'inherit' });
  }

  const child = spawn('docker', dockerArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const tee = (chunk, stream) => {
    stream.write(chunk);
    appendLogFile(logPath, chunk.toString());
  };
  child.stdout.on('data', (chunk) => tee(chunk, process.stdout));
  child.stderr.on('data', (chunk) => tee(chunk, process.stderr));
  return child;
}

module.exports = {
  DOCKER_CONTAINER_CLEANUP_POLICY,
  getDockerContainerCleanupPolicy,
  isAbnormalDockerExit,
  shouldCleanupDockerContainer,
  getDockerContainerCleanupInstructions,
  appendDockerContainerCleanupPolicyMessage,
  readDockerContainerOomKilled,
  removeDockerContainer,
  buildDetachedDockerCompletionScript,
  startDetachedDockerCompletionWatcher,
  spawnAttachedDocker,
};
