/** Populate before publishing: a failed write must never poison the shared lock. */
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 60000;
const MALFORMED_LOCK_GRACE_MS = 3000;

class LockManager {
  constructor(lockFilePath, filesystem = fs) {
    this.lockFilePath = lockFilePath;
    this.fs = filesystem;
    this.lockAcquired = false;
    this.identity = null;
  }

  acquire(timeout = LOCK_TIMEOUT_MS) {
    const started = Date.now();
    const debug = (message) => {
      if (process.env.START_DEBUG === '1') {
        console.error(`[DEBUG] Store lock ${this.lockFilePath}: ${message}`);
      }
    };
    while (Date.now() - started < timeout) {
      const temp = `${this.lockFilePath}.${process.pid}.${crypto.randomUUID()}`;
      try {
        try {
          const stat = this.fs.statSync(this.lockFilePath);
          if (this.isLockStale(this.readLockFile(), stat)) {
            const current = this.fs.statSync(this.lockFilePath);
            if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) {
              debug('reclaiming stale or malformed lock');
              this.fs.unlinkSync(this.lockFilePath);
            }
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
        this.fs.writeFileSync(
          temp,
          JSON.stringify({
            pid: process.pid,
            timestamp: Date.now(),
            hostname: os.hostname(),
          }),
          { flag: 'wx' }
        );
        const handle = this.fs.openSync(temp, 'r+');
        try {
          this.fs.fsyncSync(handle);
        } finally {
          this.fs.closeSync(handle);
        }
        const identity = this.fs.statSync(temp);
        this.fs.linkSync(temp, this.lockFilePath);
        this.identity = identity;
        this.lockAcquired = true;
        debug(`acquired after ${Date.now() - started}ms`);
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        this.sleep(100);
      } finally {
        try {
          this.fs.unlinkSync(temp);
        } catch {
          /* May not have been created. */
        }
      }
    }
    debug('acquisition timed out');
    return false;
  }

  release() {
    if (!this.lockAcquired) {
      return;
    }
    try {
      const current = this.fs.statSync(this.lockFilePath);
      if (
        current.dev === this.identity.dev &&
        current.ino === this.identity.ino
      ) {
        this.fs.unlinkSync(this.lockFilePath);
      }
    } catch {
      /* The lock may already be gone. */
    }
    this.lockAcquired = false;
  }

  readLockFile() {
    try {
      return JSON.parse(this.fs.readFileSync(this.lockFilePath, 'utf8'));
    } catch {
      return null;
    }
  }

  isLockStale(data, stat) {
    if (
      !data ||
      !Number.isFinite(data.timestamp) ||
      !Number.isInteger(data.pid) ||
      data.pid <= 0 ||
      data.pid > 2147483647
    ) {
      return Boolean(
        stat && Date.now() - stat.mtimeMs >= MALFORMED_LOCK_GRACE_MS
      );
    }
    if (data.hostname === os.hostname()) {
      try {
        process.kill(data.pid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    }
    return Date.now() - data.timestamp > LOCK_STALE_MS;
  }

  sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

module.exports = { LockManager, LOCK_TIMEOUT_MS, MALFORMED_LOCK_GRACE_MS };
