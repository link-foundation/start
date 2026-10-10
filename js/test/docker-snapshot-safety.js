const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  preflightSnapshot,
  acquireSnapshotLock,
  containerdRoot,
} = require('../src/lib/docker-snapshot-safety');

const GiB = 1024 ** 3;
function runner(size, containerd = false) {
  return (_bin, args) => ({
    success: true,
    stdout:
      args[0] === 'info'
        ? JSON.stringify({
            DockerRootDir: '/docker',
            DriverStatus: containerd
              ? [['driver-type', 'io.containerd.snapshotter.v1']]
              : [],
          })
        : String(size),
  });
}

test('preflight refuses insufficient space before any snapshot', () => {
  assert.throws(
    () =>
      preflightSnapshot('box', runner(12 * GiB), {
        freeBytes: () => 20 * GiB,
      }),
    /Insufficient disk.*34\.00 GiB/
  );
});

test('containerd image store checks Docker and containerd filesystems separately', () => {
  const checked = [];
  assert.throws(
    () =>
      preflightSnapshot('box', runner(8 * GiB, true), {
        containerdRoot: '/containerd',
        freeBytes: (root) => {
          checked.push(root);
          return root === '/docker' ? 100 * GiB : 25 * GiB;
        },
      }),
    /\/containerd/
  );
  assert.deepEqual(checked, ['/docker', '/containerd']);
});

test('preflight logs the layer size and rejects unknown sizes or roots', () => {
  assert.match(
    preflightSnapshot('box', runner(GiB), { freeBytes: () => 100 * GiB })
      .message,
    /snapshotting 1\.00 GiB/
  );
  assert.throws(
    () => preflightSnapshot('box', runner('unknown')),
    /writable layer/
  );
  assert.equal(
    containerdRoot('version = 2\nroot = "/custom"\n[plugins]\nroot = "/wrong"'),
    '/custom'
  );
});

test('snapshot lock is separate from store locks and excludes concurrent processes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-lock-'));
  const lockPath = path.join(dir, 'snapshot.lock');
  try {
    const lock = acquireSnapshotLock({ lockPath });
    assert.throws(
      () => acquireSnapshotLock({ lockPath }),
      /snapshot.*in progress/
    );
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `
      try {
        require(${JSON.stringify(require.resolve('../src/lib/docker-snapshot-safety'))}).acquireSnapshotLock();
        process.exitCode = 3;
      } catch (error) {
        console.log(error.message);
        process.exitCode = 2;
      }
    `,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, START_SNAPSHOT_LOCK: lockPath },
      }
    );
    assert.equal(child.status, 2, child.stderr);
    assert.match(child.stdout, /snapshot.*in progress/);
    lock.release();
    acquireSnapshotLock({ lockPath }).release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
