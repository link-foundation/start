/** Serialize costly snapshot resumes and check every image-store filesystem. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LockManager } = require('./store-lock');

const GiB = 1024 ** 3;
const SNAPSHOT_RESERVE_BYTES = 10 * GiB;
const SNAPSHOT_IMAGE_LABEL = 'start-command.snapshot-image';

function acquireSnapshotLock(options = {}) {
  const lockPath =
    options.lockPath ||
    process.env.START_SNAPSHOT_LOCK ||
    path.join(
      process.platform === 'win32' ? os.tmpdir() : '/tmp',
      'start-command-docker-snapshot.lock'
    );
  const lock = new LockManager(lockPath);
  // The ordinary store lock is held only for a brief write. A snapshot can
  // legitimately take hours, so never reclaim this lock merely for its age.
  lock.isLockStale = (data) => {
    if (
      !data ||
      data.hostname !== os.hostname() ||
      !Number.isInteger(data.pid) ||
      data.pid <= 0
    ) {
      return false;
    }
    try {
      process.kill(data.pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  };
  if (!lock.acquire(1000)) {
    throw new Error(
      'A Docker snapshot resume is in progress on this host. Retry after it finishes.'
    );
  }
  return lock;
}

function containerdRoot(config = '') {
  // Only the root-level TOML key configures containerd's storage root.
  const topLevel = config.split(/^\s*\[/m)[0];
  return (
    topLevel.match(/^\s*root\s*=\s*["']([^"']+)["']/m)?.[1] ||
    '/var/lib/containerd'
  );
}

function defaultContainerdRoot() {
  if (process.env.START_CONTAINERD_ROOT) {
    return process.env.START_CONTAINERD_ROOT;
  }
  try {
    return containerdRoot(
      fs.readFileSync('/etc/containerd/config.toml', 'utf8')
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return containerdRoot();
    }
    throw error;
  }
}

function readFreeBytes(root) {
  const stats = fs.statfsSync(root, { bigint: true });
  return Number(stats.bavail * stats.bsize);
}

function preflightSnapshot(containerName, runner, options = {}) {
  const docker = require('./docker-cleanup').getDockerCommand();
  const sizeResult = runner(docker, [
    'inspect',
    '--size',
    '--format',
    '{{.SizeRw}}',
    containerName,
  ]);
  const size = Number(String(sizeResult.stdout || '').trim());
  if (
    !sizeResult.success ||
    !/^\d+$/.test(String(sizeResult.stdout || '').trim()) ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    throw new Error(
      'Cannot determine the writable layer size; refusing Docker snapshot resume.'
    );
  }
  const infoResult = runner(docker, ['info', '--format', '{{json .}}']);
  let info;
  try {
    info = JSON.parse(infoResult.stdout);
  } catch {
    /* Refuse unknown storage. */
  }
  if (!infoResult.success || !info?.DockerRootDir) {
    throw new Error(
      'Cannot determine Docker data root; refusing Docker snapshot resume.'
    );
  }
  const roots = [info.DockerRootDir];
  if (
    JSON.stringify(info.DriverStatus || []).includes(
      'io.containerd.snapshotter'
    )
  ) {
    roots.push(options.containerdRoot || defaultContainerdRoot());
  }
  const required = 2 * size + (options.reserveBytes ?? SNAPSHOT_RESERVE_BYTES);
  const free = options.freeBytes || readFreeBytes;
  for (const root of [...new Set(roots)]) {
    let available;
    try {
      available = free(root);
    } catch (error) {
      throw new Error(
        `Cannot check free disk at ${root}: ${error.message}; refusing Docker snapshot resume.`,
        { cause: error }
      );
    }
    if (!Number.isFinite(available) || available < required) {
      throw new Error(
        `Insufficient disk at ${root}: need ${(required / GiB).toFixed(2)} GiB (2 × writable layer plus reserve), available ${(available / GiB).toFixed(2)} GiB. Docker snapshot resume refused.`
      );
    }
  }
  return {
    size,
    required,
    roots,
    message: `[Resume] snapshotting ${(size / GiB).toFixed(2)} GiB; disk preflight passed (${(required / GiB).toFixed(2)} GiB required).`,
  };
}

function snapshotImageCleanupSnippet(
  containerName,
  redirection = '>/dev/null 2>&1'
) {
  const { shellQuote } = require('./isolation-log-utils');
  const name = shellQuote(containerName);
  const format = shellQuote(
    `{{index .Config.Labels "${SNAPSHOT_IMAGE_LABEL}"}}`
  );
  return {
    capture: `__start_snapshot_image=$(docker inspect -f ${format} ${name} 2>/dev/null || true)`,
    remove: `case "$__start_snapshot_image" in start-command-resume/*) docker rmi "$__start_snapshot_image" ${redirection} || true;; esac`,
  };
}

module.exports = {
  acquireSnapshotLock,
  containerdRoot,
  preflightSnapshot,
  SNAPSHOT_RESERVE_BYTES,
  SNAPSHOT_IMAGE_LABEL,
  snapshotImageCleanupSnippet,
};
