const { spawn, spawnSync } = require('child_process');
const {
  appendLogFile,
  createShellLogFooterSnippet,
  shellQuote,
} = require('./isolation-log-utils');

const DOCKER_CONTAINER_CLEANUP_POLICY = {
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
  return DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS;
}

function shouldCleanupDockerContainer(policy, exitCode) {
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
    return true;
  }
  if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL) {
    return exitCode === 0;
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
      `\nContainer will be kept if the command fails.` +
      `\nRemove when done: docker rm -f ${containerName}`
    );
  }
  return `${message}\nContainer will be removed after command completes.`;
}

function removeDockerContainer(containerName, logPath = null) {
  const result = spawnSync('docker', ['rm', '-f', containerName], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (logPath && output) {
    appendLogFile(logPath, output.endsWith('\n') ? output : `${output}\n`);
  }
  return !result.error && result.status === 0;
}

function buildDetachedDockerCompletionScript(containerName, policy, logPath) {
  const quotedName = shellQuote(containerName);
  const parts = [];

  if (logPath) {
    const quotedLogPath = shellQuote(logPath);
    parts.push(`docker logs -f ${quotedName} >> ${quotedLogPath} 2>&1`);
    parts.push(
      `__start_command_exit=$(docker inspect -f '{{.State.ExitCode}}' ${quotedName} 2>/dev/null || printf '%s' '-1')`
    );
    if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
      parts.push(`docker rm -f ${quotedName} >> ${quotedLogPath} 2>&1 || true`);
    } else if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL) {
      parts.push(
        `if [ "$__start_command_exit" -eq 0 ] 2>/dev/null; then docker rm -f ${quotedName} >> ${quotedLogPath} 2>&1 || true; fi`
      );
    }
    parts.push(`${createShellLogFooterSnippet()} >> ${quotedLogPath}`);
  } else {
    parts.push(`docker wait ${quotedName} >/dev/null 2>&1`);
    parts.push(
      `__start_command_exit=$(docker inspect -f '{{.State.ExitCode}}' ${quotedName} 2>/dev/null || printf '%s' '-1')`
    );
    if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.ALWAYS) {
      parts.push(`docker rm -f ${quotedName} >/dev/null 2>&1 || true`);
    } else if (policy === DOCKER_CONTAINER_CLEANUP_POLICY.KEEP_ON_FAIL) {
      parts.push(
        `if [ "$__start_command_exit" -eq 0 ] 2>/dev/null; then docker rm -f ${quotedName} >/dev/null 2>&1 || true; fi`
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
  shouldCleanupDockerContainer,
  getDockerContainerCleanupInstructions,
  appendDockerContainerCleanupPolicyMessage,
  removeDockerContainer,
  startDetachedDockerCompletionWatcher,
  spawnAttachedDocker,
};
