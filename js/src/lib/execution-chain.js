/**
 * Continuation chains (issue #231): a launch with `--continues <id>` stores
 * the UUID it continues, so a supervisor that relaunches fresh instead of
 * `--resume`-ing in place can still treat every execution of one task as a
 * whole. `--status` prints the chain and `--upload-log` uploads one file with
 * every execution of it, oldest first.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executionAliases, hasUserNames } = require('./execution-identity');

/**
 * UUIDs of the chain `record` belongs to, oldest first. Backward links come
 * from `continues`; forward, the most recently started record that continues
 * the current one is followed. Cycles stop the walk.
 * @param {object[]} records - Stored records
 * @param {object} record - Any member of the chain
 * @returns {object[]} Records of the chain, oldest first
 */
function buildChain(records, record) {
  const seen = new Set([record.uuid]);
  const chain = [record];
  for (let cur = record; cur.continues;) {
    const prev = records.find((r) => r.uuid === cur.continues);
    if (!prev || seen.has(prev.uuid)) {
      break;
    }
    seen.add(prev.uuid);
    chain.unshift(prev);
    cur = prev;
  }
  for (let cur = record; ;) {
    const next = records
      .filter((r) => r.continues === cur.uuid && !seen.has(r.uuid))
      .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))[0];
    if (!next) {
      break;
    }
    seen.add(next.uuid);
    chain.push(next);
    cur = next;
  }
  return chain;
}

/**
 * Resolve `--continues <id>` for a new launch to the UUID it stores.
 * @param {object|null} store - ExecutionStore
 * @param {string} identifier - Any name of the earlier execution
 * @param {string} sessionId - UUID of the new launch
 * @returns {string} UUID of the continued execution
 * @throws {Error} When it cannot be resolved
 */
function resolveContinues(store, identifier, sessionId) {
  if (!store) {
    throw new Error('--continues requires execution tracking.');
  }
  const target = store.get(identifier);
  if (!target) {
    throw new Error(
      `No execution found with UUID or session name: ${identifier}`
    );
  }
  if (target.uuid === sessionId) {
    throw new Error(`Execution ${sessionId} cannot continue itself`);
  }
  return target.uuid;
}

/**
 * Wrap a status record so `toObject()` also reports the names it answers to
 * (`aliases`, once `--alias`/`--rename` gave it one) and its continuation
 * `chain`, right after `uuid`.
 * @param {object} record - Record-like object with toObject()
 * @param {object|null} store - ExecutionStore
 * @returns {object} The record, or a wrapper with the extra fields
 */
function attachIdentity(record, store) {
  const aliases = hasUserNames(record) ? executionAliases(record) : null;
  const chain =
    store &&
    (record.continues ||
      store.getAll().some((r) => r.continues === record.uuid))
      ? buildChain(store.getAll(), record).map((r) => r.uuid)
      : null;
  if (!aliases && !(chain && chain.length > 1)) {
    return record;
  }
  const wrapped = Object.create(Object.getPrototypeOf(record));
  Object.assign(wrapped, record);
  const source = record.toObject.bind(record);
  wrapped.toObject = function () {
    const ordered = {};
    for (const [key, value] of Object.entries(source())) {
      ordered[key] = value;
      if (key === 'uuid') {
        if (aliases) {
          ordered.aliases = aliases;
        }
        if (chain && chain.length > 1) {
          ordered.chain = chain;
        }
      }
    }
    return ordered;
  };
  return wrapped;
}

/**
 * Text-format lines for the identity fields of a status object.
 * @param {object} obj - Output of toObject()
 * @returns {string[]} Lines
 */
function identityTextLines(obj) {
  return [
    ...(obj.aliases ? [`Aliases:           ${obj.aliases.join(', ')}`] : []),
    ...(obj.continues ? [`Continues:         ${obj.continues}`] : []),
    ...(obj.chain ? [`Chain:             ${obj.chain.join(' -> ')}`] : []),
  ];
}

/**
 * Concatenate the logs of a chain into one temporary file, oldest first,
 * each preceded by a lifecycle header in the format `--resume` writes.
 * @param {object[]} chain - Records, oldest first
 * @returns {{path: string, cleanup: Function}} Combined log
 */
function writeChainLog(chain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-chain-log-'));
  const file = path.join(dir, `${chain[chain.length - 1].uuid}.chain.log`);
  chain.forEach((record, index) => {
    const header = {
      event: 'continuation',
      uuid: record.uuid,
      chainIndex: index + 1,
      chainLength: chain.length,
      continues: record.continues || null,
      command: record.command,
      startTime: record.startTime,
      logPath: record.logPath || null,
    };
    fs.appendFileSync(
      file,
      `\n[Start Command Lifecycle] ${JSON.stringify(header)}\n`
    );
    if (record.logPath && fs.existsSync(record.logPath)) {
      fs.appendFileSync(file, fs.readFileSync(record.logPath));
    } else {
      fs.appendFileSync(file, `Log file not found: ${record.logPath}\n`);
    }
  });
  return {
    path: file,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Log path `--upload-log` should upload for `record`: its own log, or a
 * combined log when it belongs to a chain of more than one execution.
 * @param {object} store - ExecutionStore
 * @param {object} record - Resolved record
 * @returns {{path: string, cleanup: Function}} Log to upload
 */
function prepareUploadLog(store, record) {
  const chain = buildChain(store.getAll(), record);
  if (chain.length < 2) {
    return { path: record.logPath, cleanup: () => {} };
  }
  return writeChainLog(chain);
}

module.exports = {
  attachIdentity,
  buildChain,
  identityTextLines,
  prepareUploadLog,
  resolveContinues,
  writeChainLog,
};
