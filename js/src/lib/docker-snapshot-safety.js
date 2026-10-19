/** Serialize costly snapshot resumes and check every image-store filesystem. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LockManager } = require('./store-lock');

const GiB = 1024 ** 3;
const SNAPSHOT_RESERVE_BYTES = 10 * GiB;
const SNAPSHOT_IMAGE_LABEL = 'start-command.snapshot-image';

/** sysexits.h EX_TEMPFAIL: the resume can succeed when retried later. */
const EX_TEMPFAIL = 75;

function tempfail(message) {
  const error = new Error(message);
  error.exitCode = EX_TEMPFAIL;
  return error;
}

function formatSeconds(seconds) {
  return `${Number(seconds.toFixed(3))}s`;
}

function notifier(options) {
  return options.notify || ((line) => process.stderr.write(`${line}\n`));
}

/**
 * Take the host-wide snapshot lock. With `waitSeconds` above 0 a busy lock is
 * waited for (issue #224); the wait is announced once with the holder's name.
 * @param {object} [options] - {lockPath, holder, waitSeconds, notify}
 * @returns {LockManager} The held lock
 * @throws {Error} With `exitCode` 75 when the lock stays busy
 */
function acquireSnapshotLock(options = {}) {
  const lockPath =
    options.lockPath ||
    process.env.START_SNAPSHOT_LOCK ||
    path.join(
      process.platform === 'win32' ? os.tmpdir() : '/tmp',
      'start-command-docker-snapshot.lock'
    );
  const lock = new LockManager(lockPath);
  if (options.holder) {
    lock.metadata = { holder: options.holder };
  }
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
  const waitMs = Math.max(0, (options.waitSeconds || 0) * 1000);
  if (lock.acquire(Math.min(1000, waitMs || 1000))) {
    return lock;
  }
  const holder = lock.readLockFile()?.holder;
  const busy = holder
    ? `A Docker snapshot resume of ${holder} is in progress on this host.`
    : 'A Docker snapshot resume is in progress on this host.';
  if (waitMs <= 1000) {
    throw tempfail(
      `${busy} Retry after it finishes, or wait for it with --snapshot-wait <seconds>.`
    );
  }
  notifier(options)(
    `[Resume] Waiting up to ${formatSeconds(waitMs / 1000)} for the snapshot of ${holder || 'another container'} to finish before snapshotting ${options.holder || 'this container'}.`
  );
  if (lock.acquire(waitMs - 1000)) {
    return lock;
  }
  throw tempfail(
    `${busy} Still busy after waiting ${formatSeconds(waitMs / 1000)}; retry after it finishes.`
  );
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

function measureWritableLayer(containerName, runner, docker, options) {
  if (options.sizeHint !== null && options.sizeHint !== undefined) {
    return { size: options.sizeHint, source: 'size hint' };
  }
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
  return { size, source: null };
}

function imageStoreRoots(runner, docker, options) {
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
  return [...new Set(roots)];
}

/** @returns {?object} The first root without enough space, or null */
function findShortRoot(roots, required, free) {
  for (const root of roots) {
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
      return { root, available };
    }
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Refuse a snapshot that could fill the disk. The writable layer is measured
 * once (or taken from `sizeHint`); with `diskWaitSeconds` the free space is
 * re-checked every `diskPollSeconds` until it suffices (issue #224).
 * @param {object} [options] - {sizeHint, diskWaitSeconds, diskPollSeconds,
 *   reserveBytes, freeBytes, containerdRoot, notify, sleep, now}
 * @throws {Error} With `exitCode` 75 when the disk stays short
 */
function preflightSnapshot(containerName, runner, options = {}) {
  const docker = require('./docker-cleanup').getDockerCommand();
  const { size, source } = measureWritableLayer(
    containerName,
    runner,
    docker,
    options
  );
  const roots = imageStoreRoots(runner, docker, options);
  const required = 2 * size + (options.reserveBytes ?? SNAPSHOT_RESERVE_BYTES);
  const free = options.freeBytes || readFreeBytes;
  const waitMs = Math.max(0, (options.diskWaitSeconds || 0) * 1000);
  const pollMs = Math.max(
    1,
    (options.diskPollSeconds ??
      Number(process.env.START_SNAPSHOT_DISK_POLL || 10)) * 1000
  );
  const now = options.now || Date.now;
  const sleep = options.sleep || sleepSync;
  const started = now();
  let waited = false;
  for (;;) {
    const short = findShortRoot(roots, required, free);
    if (!short) {
      break;
    }
    const detail = `Insufficient disk at ${short.root}: need ${(required / GiB).toFixed(2)} GiB (2 × writable layer plus reserve), available ${(short.available / GiB).toFixed(2)} GiB.`;
    const left = waitMs - (now() - started);
    if (left <= 0) {
      throw tempfail(
        waited
          ? `${detail} Still short after waiting ${formatSeconds(waitMs / 1000)}; Docker snapshot resume refused.`
          : `${detail} Docker snapshot resume refused.`
      );
    }
    if (!waited) {
      notifier(options)(
        `[Resume] Waiting up to ${formatSeconds(waitMs / 1000)} for disk: ${detail}`
      );
      waited = true;
    }
    sleep(Math.min(pollMs, left));
  }
  const measured = source
    ? `${(size / GiB).toFixed(2)} GiB (${source})`
    : `${(size / GiB).toFixed(2)} GiB`;
  return {
    size,
    required,
    roots,
    message: `[Resume] snapshotting ${measured}; disk preflight passed (${(required / GiB).toFixed(2)} GiB required).`,
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
  EX_TEMPFAIL,
  acquireSnapshotLock,
  containerdRoot,
  preflightSnapshot,
  SNAPSHOT_RESERVE_BYTES,
  SNAPSHOT_IMAGE_LABEL,
  snapshotImageCleanupSnippet,
};
