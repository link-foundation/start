/**
 * Execution Store - Dual storage for command execution records
 *
 * Stores command execution data in:
 * 1. Text format (.lino files) using lino-objects-codec
 * 2. Binary format (.links database) using clink if available
 *
 * Each execution record contains:
 * - uuid: Unique identifier for the command call
 * - pid: Process ID
 * - status: 'executing' or 'executed'
 * - exitCode: Return status code (null while executing)
 * - command: The command string that was executed
 * - logPath: Path to the log file
 * - startTime: Timestamp when execution started
 * - endTime: Timestamp when execution completed (null while executing)
 * - options: Execution options (isolation mode, etc.)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');

// Synchronous wrapper using Bun's native ESM support
// This works because Bun handles ESM/CJS interop
function encodeSync(data) {
  // Use synchronous require with Bun's ESM support
  try {
    const codec = require('lino-objects-codec');
    return codec.encode({ obj: data });
  } catch {
    return JSON.stringify(data);
  }
}

function decodeSync(notation) {
  try {
    const codec = require('lino-objects-codec');
    return codec.decode({ notation });
  } catch {
    return JSON.parse(notation);
  }
}

// Configuration
const DEFAULT_APP_FOLDER = path.join(os.homedir(), '.start-command');
const LINO_DB_FILE = 'executions.lino';
const LINKS_DB_FILE = 'executions.links';
const LOCK_FILE = 'executions.lock';
const LOCK_TIMEOUT_MS = 30000; // 30 second timeout for lock acquisition
const LOCK_STALE_MS = 60000; // Consider lock stale after 60 seconds

/**
 * Execution status enumeration
 */
const ExecutionStatus = {
  EXECUTING: 'executing',
  EXECUTED: 'executed',
};

/**
 * Command Execution Record
 */
class ExecutionRecord {
  constructor(options = {}) {
    this.uuid = options.uuid || crypto.randomUUID();
    this.pid = options.pid || null;
    this.status = options.status || ExecutionStatus.EXECUTING;
    this.exitCode = options.exitCode !== undefined ? options.exitCode : null;
    this.command = options.command || '';
    this.logPath = options.logPath || '';
    this.startTime = options.startTime || new Date().toISOString();
    this.endTime = options.endTime || null;
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.shell = options.shell || process.env.SHELL || '/bin/sh';
    this.platform = options.platform || process.platform;
    this.options = options.options || {};
  }

  /**
   * Mark execution as completed
   * @param {number} exitCode - Exit code from the process
   */
  complete(exitCode) {
    this.status = ExecutionStatus.EXECUTED;
    this.exitCode = exitCode;
    this.endTime = new Date().toISOString();
  }

  /**
   * Convert to plain object for serialization
   */
  toObject() {
    return {
      uuid: this.uuid,
      pid: this.pid,
      status: this.status,
      exitCode: this.exitCode,
      command: this.command,
      logPath: this.logPath,
      startTime: this.startTime,
      endTime: this.endTime,
      workingDirectory: this.workingDirectory,
      shell: this.shell,
      platform: this.platform,
      options: this.options,
    };
  }

  /**
   * Create from plain object
   */
  static fromObject(obj) {
    return new ExecutionRecord(obj);
  }
}

/**
 * File-based lock manager
 */
class LockManager {
  constructor(lockFilePath) {
    this.lockFilePath = lockFilePath;
    this.lockAcquired = false;
  }

  /**
   * Acquire an exclusive lock
   * @param {number} timeout - Maximum time to wait for lock in ms
   * @returns {boolean} True if lock acquired
   */
  acquire(timeout = LOCK_TIMEOUT_MS) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        // Check if existing lock is stale
        if (fs.existsSync(this.lockFilePath)) {
          const lockData = this.readLockFile();
          if (lockData && this.isLockStale(lockData)) {
            // Remove stale lock
            fs.unlinkSync(this.lockFilePath);
          }
        }

        // Try to create lock file exclusively
        const lockData = {
          pid: process.pid,
          timestamp: Date.now(),
          hostname: os.hostname(),
        };

        fs.writeFileSync(this.lockFilePath, JSON.stringify(lockData), {
          flag: 'wx', // Fail if file exists
        });

        this.lockAcquired = true;
        return true;
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Lock file exists, wait and retry
          this.sleep(100);
          continue;
        }
        throw err;
      }
    }

    return false;
  }

  /**
   * Release the lock
   */
  release() {
    if (this.lockAcquired) {
      try {
        fs.unlinkSync(this.lockFilePath);
      } catch {
        // Ignore errors during release
      }
      this.lockAcquired = false;
    }
  }

  /**
   * Read lock file data
   */
  readLockFile() {
    try {
      const content = fs.readFileSync(this.lockFilePath, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Check if lock is stale
   */
  isLockStale(lockData) {
    if (!lockData || !lockData.timestamp) {
      return true;
    }

    // Check if lock is too old
    if (Date.now() - lockData.timestamp > LOCK_STALE_MS) {
      return true;
    }

    // Check if the process that holds the lock is still running
    if (lockData.pid && lockData.hostname === os.hostname()) {
      try {
        process.kill(lockData.pid, 0); // Signal 0 just checks if process exists
        return false; // Process exists, lock is valid
      } catch {
        return true; // Process doesn't exist, lock is stale
      }
    }

    return false;
  }

  /**
   * Simple sleep function
   */
  sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy wait (not ideal but works for short durations)
    }
  }
}

/**
 * Check if clink is installed
 * @returns {boolean}
 */
function isClinkInstalled() {
  try {
    const result = spawnSync('clink', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * ExecutionStore - Main store class for managing execution records
 */
class ExecutionStore {
  constructor(options = {}) {
    this.appFolder = options.appFolder || DEFAULT_APP_FOLDER;
    this.linoDbPath = path.join(this.appFolder, LINO_DB_FILE);
    this.linksDbPath = path.join(this.appFolder, LINKS_DB_FILE);
    this.lockFilePath = path.join(this.appFolder, LOCK_FILE);
    this.useLinks = options.useLinks !== false && isClinkInstalled();
    this.verbose = options.verbose || false;

    // Ensure app folder exists
    this.ensureAppFolder();
  }

  /**
   * Ensure the application folder exists
   */
  ensureAppFolder() {
    if (!fs.existsSync(this.appFolder)) {
      fs.mkdirSync(this.appFolder, { recursive: true });
    }
  }

  /**
   * Log verbose message
   */
  log(message) {
    if (this.verbose) {
      console.log(`[ExecutionStore] ${message}`);
    }
  }

  /**
   * Read all execution records from lino file
   * @returns {ExecutionRecord[]}
   */
  readLinoRecords() {
    if (!fs.existsSync(this.linoDbPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.linoDbPath, 'utf8');
      if (!content.trim()) {
        return [];
      }

      const data = decodeSync(content);
      if (!Array.isArray(data)) {
        return [];
      }

      return data.map((obj) => ExecutionRecord.fromObject(obj));
    } catch (err) {
      this.log(`Error reading lino records: ${err.message}`);
      return [];
    }
  }

  /**
   * Write execution records to lino file
   * @param {ExecutionRecord[]} records
   */
  writeLinoRecords(records) {
    const data = records.map((r) => r.toObject());
    const content = encodeSync(data);
    fs.writeFileSync(this.linoDbPath, content, 'utf8');
    this.log(`Wrote ${records.length} records to lino file`);
  }

  /**
   * Convert execution record to clink links notation format
   * Uses string aliases for readable IDs
   * @param {ExecutionRecord} record
   * @returns {string}
   */
  recordToLinksNotation(record) {
    // Using clink's string alias feature for readable identifiers
    // Format: (uuid: uuid-value) (pid: pid-value) etc.
    const obj = record.toObject();
    const parts = [];

    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && value !== undefined) {
        // Escape value properly for links notation
        const escapedValue =
          typeof value === 'object' ? JSON.stringify(value) : String(value);
        parts.push(`(${record.uuid}.${key}: ${key} "${escapedValue}")`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Build clink query for creating/updating a record
   * @param {ExecutionRecord} record
   * @returns {string}
   */
  buildClinkCreateQuery(record) {
    const obj = record.toObject();
    const links = [];

    // Create main record link
    links.push(`(${record.uuid}: ExecutionRecord ${record.uuid})`);

    // Create property links
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && value !== undefined) {
        const escapedValue =
          typeof value === 'object' ? JSON.stringify(value) : String(value);
        // Using format: (uuid.property: property "value")
        links.push(`(${record.uuid}.${key}: ${key} "${escapedValue}")`);
      }
    }

    // Format: () ((links)) - creates new links
    return `() ((${links.join(') (')}))`;
  }

  /**
   * Execute clink command
   * @param {string} query
   * @returns {{success: boolean, output: string}}
   */
  execClink(query) {
    try {
      const result = execSync(`clink '${query}' --db "${this.linksDbPath}"`, {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, output: result };
    } catch (err) {
      this.log(`Clink error: ${err.message}`);
      return { success: false, output: err.message };
    }
  }

  /**
   * Write a record to the links database using clink
   * @param {ExecutionRecord} record
   * @returns {boolean}
   */
  writeLinksRecord(record) {
    if (!this.useLinks) {
      return false;
    }

    const query = this.buildClinkCreateQuery(record);
    const result = this.execClink(query);

    if (result.success) {
      this.log(`Wrote record ${record.uuid} to links database`);
    }

    return result.success;
  }

  /**
   * Delete a record from links database
   * @param {string} uuid
   * @returns {boolean}
   */
  deleteLinksRecord(uuid) {
    if (!this.useLinks) {
      return false;
    }

    // Delete all links with this UUID prefix
    const query = `(($id: ${uuid} $any)) ()`;
    const result = this.execClink(query);
    return result.success;
  }

  /**
   * Save an execution record (creates or updates)
   * @param {ExecutionRecord} record
   * @returns {boolean}
   */
  save(record) {
    const lock = new LockManager(this.lockFilePath);

    if (!lock.acquire()) {
      throw new Error('Failed to acquire lock for database write');
    }

    try {
      // Read existing records
      const records = this.readLinoRecords();

      // Find existing record index
      const existingIndex = records.findIndex((r) => r.uuid === record.uuid);

      if (existingIndex >= 0) {
        // Update existing record
        records[existingIndex] = record;
      } else {
        // Add new record
        records.push(record);
      }

      // Write to lino file
      this.writeLinoRecords(records);

      // Also write to links database if available
      if (this.useLinks) {
        this.writeLinksRecord(record);
      }

      return true;
    } finally {
      lock.release();
    }
  }

  /**
   * Get an execution record by UUID
   * @param {string} uuid
   * @returns {ExecutionRecord|null}
   */
  get(uuid) {
    const records = this.readLinoRecords();
    const found = records.find((r) => r.uuid === uuid);
    return found || null;
  }

  /**
   * Get all execution records
   * @returns {ExecutionRecord[]}
   */
  getAll() {
    return this.readLinoRecords();
  }

  /**
   * Get records filtered by status
   * @param {string} status
   * @returns {ExecutionRecord[]}
   */
  getByStatus(status) {
    return this.readLinoRecords().filter((r) => r.status === status);
  }

  /**
   * Get currently executing commands
   * @returns {ExecutionRecord[]}
   */
  getExecuting() {
    return this.getByStatus(ExecutionStatus.EXECUTING);
  }

  /**
   * Get recently executed commands
   * @param {number} limit
   * @returns {ExecutionRecord[]}
   */
  getRecent(limit = 10) {
    const records = this.readLinoRecords();
    // Sort by startTime descending
    records.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    return records.slice(0, limit);
  }

  /**
   * Delete an execution record
   * @param {string} uuid
   * @returns {boolean}
   */
  delete(uuid) {
    const lock = new LockManager(this.lockFilePath);

    if (!lock.acquire()) {
      throw new Error('Failed to acquire lock for database write');
    }

    try {
      const records = this.readLinoRecords();
      const filteredRecords = records.filter((r) => r.uuid !== uuid);

      if (filteredRecords.length === records.length) {
        return false; // Record not found
      }

      this.writeLinoRecords(filteredRecords);

      // Also delete from links database
      if (this.useLinks) {
        this.deleteLinksRecord(uuid);
      }

      return true;
    } finally {
      lock.release();
    }
  }

  /**
   * Delete all records
   */
  clear() {
    const lock = new LockManager(this.lockFilePath);

    if (!lock.acquire()) {
      throw new Error('Failed to acquire lock for database write');
    }

    try {
      this.writeLinoRecords([]);

      // Clear links database by removing the file
      if (this.useLinks && fs.existsSync(this.linksDbPath)) {
        fs.unlinkSync(this.linksDbPath);
      }
    } finally {
      lock.release();
    }
  }

  /**
   * Verify that both databases have consistent data
   * @returns {{consistent: boolean, linoCount: number, linksCount: number, errors: string[]}}
   */
  verifyConsistency() {
    const result = {
      consistent: true,
      linoCount: 0,
      linksCount: 0,
      errors: [],
    };

    // Read lino records
    const linoRecords = this.readLinoRecords();
    result.linoCount = linoRecords.length;

    if (!this.useLinks) {
      // If clink is not available, just report lino count
      result.linksCount = 0;
      result.errors.push('clink not installed - links database not available');
      return result;
    }

    // Query links database for all ExecutionRecord links
    try {
      const queryResult = this.execClink(
        `((($id: ExecutionRecord $uuid)) (($id: ExecutionRecord $uuid)))`
      );

      if (queryResult.success) {
        // Count unique UUIDs in the links output
        const output = queryResult.output || '';
        const uuidMatches = output.match(/ExecutionRecord\s+([a-f0-9-]{36})/gi);
        const uniqueUuids = new Set(
          (uuidMatches || []).map((m) =>
            m.replace(/ExecutionRecord\s+/i, '').toLowerCase()
          )
        );
        result.linksCount = uniqueUuids.size;

        // Check if counts match
        if (result.linoCount !== result.linksCount) {
          result.consistent = false;
          result.errors.push(
            `Record count mismatch: lino=${result.linoCount}, links=${result.linksCount}`
          );
        }

        // Verify each lino record exists in links
        for (const record of linoRecords) {
          if (!uniqueUuids.has(record.uuid.toLowerCase())) {
            result.consistent = false;
            result.errors.push(
              `Record ${record.uuid} missing from links database`
            );
          }
        }
      } else {
        result.errors.push(
          `Failed to query links database: ${queryResult.output}`
        );
        result.consistent = false;
      }
    } catch (err) {
      result.errors.push(`Links verification error: ${err.message}`);
      result.consistent = false;
    }

    return result;
  }

  /**
   * Sync lino records to links database (repair operation)
   * @returns {{synced: number, errors: string[]}}
   */
  syncToLinks() {
    if (!this.useLinks) {
      return { synced: 0, errors: ['clink not installed'] };
    }

    const lock = new LockManager(this.lockFilePath);
    if (!lock.acquire()) {
      throw new Error('Failed to acquire lock for sync operation');
    }

    try {
      const records = this.readLinoRecords();
      let synced = 0;
      const errors = [];

      for (const record of records) {
        if (this.writeLinksRecord(record)) {
          synced++;
        } else {
          errors.push(`Failed to sync record ${record.uuid}`);
        }
      }

      return { synced, errors };
    } finally {
      lock.release();
    }
  }

  /**
   * Get database statistics
   * @returns {object}
   */
  getStats() {
    const records = this.readLinoRecords();
    const executing = records.filter(
      (r) => r.status === ExecutionStatus.EXECUTING
    ).length;
    const executed = records.filter(
      (r) => r.status === ExecutionStatus.EXECUTED
    ).length;
    const successful = records.filter(
      (r) => r.status === ExecutionStatus.EXECUTED && r.exitCode === 0
    ).length;
    const failed = records.filter(
      (r) => r.status === ExecutionStatus.EXECUTED && r.exitCode !== 0
    ).length;

    return {
      total: records.length,
      executing,
      executed,
      successful,
      failed,
      clinkAvailable: this.useLinks,
      linoDbPath: this.linoDbPath,
      linksDbPath: this.linksDbPath,
    };
  }
}

// Export everything
module.exports = {
  ExecutionStore,
  ExecutionRecord,
  ExecutionStatus,
  LockManager,
  isClinkInstalled,
  DEFAULT_APP_FOLDER,
  LINO_DB_FILE,
  LINKS_DB_FILE,
  LOCK_FILE,
};
